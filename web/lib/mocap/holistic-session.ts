/**
 * 摄像头 + MediaPipe Holistic 的会话管理。
 *
 * 这个文件是 G2 里唯一直接碰硬件的模块，所以把三件容易出错的事集中在这里：
 *
 * ── ① 资源必须走本地，且缺文件要**大声失败** ─────────────────────────────
 *    MediaPipe 默认按 `window.location.pathname` 找 wasm/模型，在 Next.js 下必然 404，
 *    而它对失败的表现是**卡住而不是报错** —— 现场看就是"点了启动摄像头没反应"。
 *    所以 `start()` 第一步就是自检 vendor 目录，缺哪个文件直接抛出来。
 *
 * ── ② 推理必须串行 ────────────────────────────────────────────────────
 *    一个 Holistic 实例同时只能有一个 `send()` 在跑。不控制的话视频帧会积压：
 *    推理越来越慢、延迟越堆越大，最后画面里的动作比人慢好几秒。
 *    做法：忙的时候**丢帧**（不是排队）—— 宁可少几帧，也不要延迟累积。
 *
 * ── ③ 镜像只在呈现层 ──────────────────────────────────────────────────
 *    视频元素用 CSS 镜像给人看，送进模型的 `<video>` 像素**不变**
 *    （CSS transform 不影响元素像素数据），`selfieMode` 恒为 false。
 *    见 display-mapping.ts 的说明。
 *
 * 另外：React StrictMode 在 dev 下会双调用 effect，`start()`/`stop()` 必须是
 * 可重入且能安全重复调用的，否则会出现两条 getUserMedia 抢同一个摄像头、
 * 或者关掉页面后摄像头指示灯还亮着。这里用「代号（generation）」来防竞态。
 */
import {
  CAPTURE_CONSTRAINTS,
  HOLISTIC_OPTIONS,
  VENDOR_URL_PATH,
  checkVendorFiles,
} from './mediapipe-assets.ts';
import { toLandmarks } from './kalidokit-solver.ts';
import type { MocapRawFrame } from './mocap-types.ts';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface HolisticFrame extends MocapRawFrame {
  /** 本次推理耗时（毫秒），用于区分"模型慢"和"摄像头慢" */
  inferenceMs: number;
}

export interface HolisticSessionOptions {
  video: HTMLVideoElement;
  onFrame: (frame: HolisticFrame) => void;
  onError?: (err: Error) => void;
  onStatus?: (status: SessionStatus, detail: string) => void;
  deviceId?: string;
}

/** 推理帧率的滑动窗口长度 */
const FPS_WINDOW = 30;

/**
 * 官方连接拓扑。
 *
 * 为什么运行时从模块里取，而不是静态 import：
 *   `import { POSE_CONNECTIONS } from '@mediapipe/holistic'` 会把 78 KB 的
 *   holistic.js 提前拉进 bundle，而且它还会被 SSR 执行到（客户端组件也会先服务端渲染）。
 *   session 反正要动态 import 这个包，顺手把常量取出来最划算，
 *   也保证连接拓扑与模型版本一致（不自己手写索引表 —— 那种表写错一个数字
 *   在画面上就是一条乱线，很难发现）。
 */
export interface HolisticConnections {
  pose: ReadonlyArray<readonly [number, number]>;
  hand: ReadonlyArray<readonly [number, number]>;
  faceOval: ReadonlyArray<readonly [number, number]>;
  faceLips: ReadonlyArray<readonly [number, number]>;
  faceLeftEye: ReadonlyArray<readonly [number, number]>;
  faceRightEye: ReadonlyArray<readonly [number, number]>;
  faceLeftEyebrow: ReadonlyArray<readonly [number, number]>;
  faceRightEyebrow: ReadonlyArray<readonly [number, number]>;
}

function asConnections(module: Record<string, unknown>): HolisticConnections | null {
  const pick = (k: string) => {
    const v = module[k];
    return Array.isArray(v) ? (v as ReadonlyArray<readonly [number, number]>) : null;
  };
  const pose = pick('POSE_CONNECTIONS');
  const hand = pick('HAND_CONNECTIONS');
  const faceOval = pick('FACEMESH_FACE_OVAL');
  if (!pose || !hand || !faceOval) return null;
  return {
    pose,
    hand,
    faceOval,
    // 下面这些缺失时退化为空数组（少画几条线比崩掉好）
    faceLips: pick('FACEMESH_LIPS') ?? [],
    faceLeftEye: pick('FACEMESH_LEFT_EYE') ?? [],
    faceRightEye: pick('FACEMESH_RIGHT_EYE') ?? [],
    faceLeftEyebrow: pick('FACEMESH_LEFT_EYEBROW') ?? [],
    faceRightEyebrow: pick('FACEMESH_RIGHT_EYEBROW') ?? [],
  };
}

interface HolisticLike {
  setOptions(opts: Record<string, unknown>): void;
  onResults(cb: (results: Record<string, unknown>) => void): void;
  send(input: { image: HTMLVideoElement }): Promise<void>;
  close?(): void;
}

/** 浏览器是否支持 requestVideoFrameCallback（Safari 17+ / Chrome 83+） */
function hasVideoFrameCallback(v: HTMLVideoElement): boolean {
  return typeof (v as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
}

export class HolisticSession {
  private video: HTMLVideoElement;
  private onFrame: (f: HolisticFrame) => void;
  private onError: (e: Error) => void;
  private onStatus: (s: SessionStatus, d: string) => void;
  private deviceId?: string;

  private stream: MediaStream | null = null;
  private holistic: HolisticLike | null = null;
  private status: SessionStatus = 'idle';
  private detail = '';
  private connections: HolisticConnections | null = null;

  /** 防竞态代号：只处理与当前代号一致的回调 */
  private generation = 0;
  /** 串行守卫：同一时刻只允许一个 send() */
  private busy = false;
  private running = false;
  private loopHandle: number | null = null;
  private loopKind: 'rvfc' | 'raf' | null = null;

  private frameTimes: number[] = [];
  private lastPoseInputs: { pose: MocapRawFrame['poseLandmarks']; world: MocapRawFrame['poseWorldLandmarks'] } = {
    pose: null,
    world: null,
  };

  constructor(opts: HolisticSessionOptions) {
    this.video = opts.video;
    this.onFrame = opts.onFrame;
    this.onError = opts.onError ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.deviceId = opts.deviceId;
  }

  get currentStatus(): SessionStatus {
    return this.status;
  }

  get statusDetail(): string {
    return this.detail;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 实际推理帧率（滑动窗口均值）。不是视频帧率 —— 用它判断机器跟不跟得上 */
  get inferenceFps(): number {
    if (this.frameTimes.length < 2) return 0;
    const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
    return span > 0 ? ((this.frameTimes.length - 1) / span) * 1000 : 0;
  }

  /** 最近一帧的身体关键点（覆盖层画身体骨架用；避免把整帧复制进 React state） */
  get lastPoseLandmarks() {
    return this.lastPoseInputs.pose;
  }

  get lastWorldLandmarks() {
    return this.lastPoseInputs.world;
  }

  private setStatus(s: SessionStatus, detail = ''): void {
    this.status = s;
    this.detail = detail;
    this.onStatus(s, detail);
  }

  /** 列出可用摄像头。首次调用前若未授权，label 会是空的 —— 这是浏览器的隐私限制 */
  static async listDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  async start(): Promise<void> {
    if (this.running || this.status === 'starting') return;

    const gen = ++this.generation;
    this.setStatus('starting', '检查本地资源');

    // ① 先自检资源。缺文件时明确报错，而不是让 MediaPipe 静默挂住
    const vendor = await checkVendorFiles();
    if (gen !== this.generation) return;
    if (!vendor.ok) {
      const msg =
        `MediaPipe 本地资源缺失 ${vendor.missing.length}/${vendor.checked} 个：${vendor.missing.join(', ')}\n` +
        `请在仓库根目录执行：node tools/sync-mediapipe.mjs`;
      this.setStatus('error', '本地资源缺失');
      throw new Error(msg);
    }

    this.setStatus('starting', '申请摄像头权限');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: this.deviceId
          ? { ...CAPTURE_CONSTRAINTS, deviceId: { exact: this.deviceId } }
          : CAPTURE_CONSTRAINTS,
        audio: false,
      });
    } catch (e) {
      if (gen !== this.generation) return;
      const err = e instanceof Error ? e : new Error(String(e));
      this.setStatus('error', `摄像头打开失败：${err.name ?? err.message}`);
      throw err;
    }
    if (gen !== this.generation) {
      // 已经被 stop 掉了（StrictMode 下的正常路径）：立刻释放，别留着摄像头
      this.releaseStream();
      return;
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch (e) {
      if (gen !== this.generation) return;
      const err = e instanceof Error ? e : new Error(String(e));
      this.setStatus('error', `视频播放失败：${err.message}`);
      this.releaseStream();
      throw err;
    }

    this.setStatus('starting', '加载 Holistic 模型');
    try {
      const mod = (await import('@mediapipe/holistic')) as unknown as Record<string, unknown> & {
        Holistic: new (opts: { locateFile: (f: string) => string }) => HolisticLike;
      };
      if (gen !== this.generation) {
        this.releaseStream();
        return;
      }
      this.connections = asConnections(mod);
      const holistic = new mod.Holistic({
        // ★ 恒定走本地，绝不落到 CDN（验收第 9 条：断网也要能跑）
        locateFile: (file: string) => `${VENDOR_URL_PATH}/${file}`,
      });
      holistic.setOptions({ ...HOLISTIC_OPTIONS });
      holistic.onResults((results) => this.handleResults(results, gen));
      this.holistic = holistic;
    } catch (e) {
      if (gen !== this.generation) return;
      const err = e instanceof Error ? e : new Error(String(e));
      this.setStatus('error', `Holistic 初始化失败：${err.message}`);
      this.releaseStream();
      throw err;
    }

    this.running = true;
    this.busy = false;
    this.frameTimes = [];
    this.setStatus('running', '识别中');
    this.scheduleFrame(gen);
  }

  /** 安全停止；可重复调用 */
  stop(): void {
    this.generation++;
    this.running = false;
    this.busy = false;
    this.cancelFrameLoop();
    try {
      this.holistic?.close?.();
    } catch {
      /* close 失败也不该阻断释放 */
    }
    this.holistic = null;
    this.releaseStream();
    this.frameTimes = [];
    this.lastPoseInputs = { pose: null, world: null };
    if (this.status !== 'error') this.setStatus('stopped', '已关闭');
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;
  }

  // ── 帧循环 ────────────────────────────────────────────────────────────

  private scheduleFrame(gen: number): void {
    if (!this.running || gen !== this.generation) return;

    if (hasVideoFrameCallback(this.video)) {
      this.loopKind = 'rvfc';
      const v = this.video as HTMLVideoElement & {
        requestVideoFrameCallback: (cb: () => void) => number;
      };
      this.loopHandle = v.requestVideoFrameCallback(() => {
        this.tick(gen);
        this.scheduleFrame(gen);
      });
    } else {
      // 回退：rAF 在某些浏览器里比视频帧快，所以下面还会用 busy 挡一层
      this.loopKind = 'raf';
      this.loopHandle = requestAnimationFrame(() => {
        this.tick(gen);
        this.scheduleFrame(gen);
      });
    }
  }

  private cancelFrameLoop(): void {
    if (this.loopHandle === null) return;
    if (this.loopKind === 'rvfc') {
      const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
      v.cancelVideoFrameCallback?.(this.loopHandle);
    } else {
      cancelAnimationFrame(this.loopHandle);
    }
    this.loopHandle = null;
    this.loopKind = null;
  }

  private tick(gen: number): void {
    if (!this.running || gen !== this.generation) return;
    // ★ 串行：忙就丢帧。排队会让延迟越积越多，宁可少几帧
    if (this.busy) return;
    if (!this.holistic || this.video.readyState < 2) return;

    this.busy = true;
    const t0 = performance.now();
    this.holistic
      .send({ image: this.video })
      .then(() => {
        this.busy = false;
        this.recordFrameTime(performance.now(), t0);
      })
      .catch((e: unknown) => {
        this.busy = false;
        if (gen !== this.generation) return;
        this.onError(e instanceof Error ? e : new Error(String(e)));
      });
  }

  private recordFrameTime(now: number, startedAt: number): void {
    this.frameTimes.push(now);
    if (this.frameTimes.length > FPS_WINDOW) this.frameTimes.shift();
    this.lastInferenceMs = now - startedAt;
  }

  private lastInferenceMs = 0;

  get inferenceMs(): number {
    return this.lastInferenceMs;
  }

  private handleResults(results: Record<string, unknown>, gen: number): void {
    if (gen !== this.generation || !this.running) return;

    const pose = toLandmarks(results.poseLandmarks);
    const world = toLandmarks(results.poseWorldLandmarks);
    this.lastPoseInputs = { pose, world };

    this.onFrame({
      timestampMs: performance.now(),
      poseLandmarks: pose,
      poseWorldLandmarks: world,
      leftHandLandmarks: toLandmarks(results.leftHandLandmarks),
      rightHandLandmarks: toLandmarks(results.rightHandLandmarks),
      faceLandmarks: toLandmarks(results.faceLandmarks),
      inferenceMs: this.lastInferenceMs,
    });
  }

  /** 当前视频分辨率（覆盖层按这个尺寸适配；用实际值而不是请求值） */
  get videoSize(): { width: number; height: number } {
    return {
      width: this.video.videoWidth || CAPTURE_CONSTRAINTS.width.ideal,
      height: this.video.videoHeight || CAPTURE_CONSTRAINTS.height.ideal,
    };
  }

  get usingVideoFrameCallback(): boolean {
    return this.loopKind === 'rvfc';
  }

  /** 官方连接拓扑（模型加载后才可用） */
  get connectionsOrNull(): HolisticConnections | null {
    return this.connections;
  }

  /** 给自动化测试用：当前活跃的 MediaStream 轨道数（应为 0 或 1） */
  get activeTrackCount(): number {
    return this.stream ? this.stream.getTracks().filter((t) => t.readyState === 'live').length : 0;
  }
}

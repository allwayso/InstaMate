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
  /**
   * rVFC 看门狗。
   *
   * ★ `requestVideoFrameCallback` **存在**不代表它会触发：标签页不可见、
   *   无头环境、没有实际画面呈现时，回调可能永远不来。
   *   早期实现把它当作"有就一定好用"，结果是一帧都收不到，
   *   而且不报错 —— 现场看就是"摄像头开了、覆盖层也在，但关键点永远不动"。
   *   所以注册之后起一个 1 秒看门狗，没触发就永久切到 rAF。
   */
  private rvfcWatchdog: ReturnType<typeof setTimeout> | null = null;
  private forceRaf = false;

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
    this.forceRaf = false;
    this.seenKeys.clear();
    this.framesWithoutWorld = 0;
    this.worldFieldSeen = null;
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
    this.framesProcessedCount = 0;
    this.seenKeys.clear();
    this.framesWithoutWorld = 0;
    this.worldFieldSeen = null;
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

    if (!this.forceRaf && hasVideoFrameCallback(this.video)) {
      this.loopKind = 'rvfc';
      let fired = false;
      const v = this.video as HTMLVideoElement & {
        requestVideoFrameCallback: (cb: () => void) => number;
      };
      this.loopHandle = v.requestVideoFrameCallback(() => {
        fired = true;
        if (this.rvfcWatchdog) {
          clearTimeout(this.rvfcWatchdog);
          this.rvfcWatchdog = null;
        }
        this.tick(gen);
        this.scheduleFrame(gen);
      });
      // 1 秒内没等到第一帧就永久降级到 rAF
      if (this.rvfcWatchdog) clearTimeout(this.rvfcWatchdog);
      this.rvfcWatchdog = setTimeout(() => {
        this.rvfcWatchdog = null;
        if (fired || !this.running || gen !== this.generation) return;
        this.forceRaf = true;
        this.cancelFrameLoop();
        this.detail = '视频帧回调未触发，已回退 rAF';
        this.onStatus(this.status, this.detail);
        this.scheduleFrame(gen);
      }, 1000);
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
    if (this.rvfcWatchdog) {
      clearTimeout(this.rvfcWatchdog);
      this.rvfcWatchdog = null;
    }
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
    this.framesProcessedCount++;
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

    // ── 字段自检（跨帧累积）──────────────────────────────────────────
    //
    // ★ 不能用 `Object.keys(results)`：MediaPipe 的输出属性是**不可枚举的 getter**，
    //   Object.keys 只返回 multiFaceGeometry 这类普通属性。
    // ★ 也不能只看第一帧：MediaPipe **只在对应流有输出时才设置那个属性**，
    //   所以某一帧里 poseLandmarks 可能就是 undefined。
    //   必须逐帧累积，并且"字段缺失"要等足够多帧才判定 —— 否则会把
    //   "这一帧没检到人"误报成"代码读错键名"。
    const PROBE = [
      'za',
      'poseWorldLandmarks',
      'poseLandmarks',
      'leftHandLandmarks',
      'rightHandLandmarks',
      'faceLandmarks',
      'segmentationMask',
      'multiFaceGeometry',
    ];
    for (const k of PROBE) {
      if (results[k] !== undefined && results[k] !== null) this.seenKeys.add(k);
    }
    for (const k of Object.keys(results)) this.seenKeys.add(k);

    // `za` 是本版本的实际键名（内部 stream 名 world_landmarks）；
    // `poseWorldLandmarks` 是类型定义那种"看上去更合理"的名字。两个都认。
    const worldPresent = this.seenKeys.has('za') || this.seenKeys.has('poseWorldLandmarks');
    if (worldPresent) {
      this.worldFieldSeen = true;
    } else {
      this.framesWithoutWorld++;
      // ★ 只有在**身体点已经能拿到**的前提下，才把"没有世界坐标"判成结构性问题。
      //   否则会把"镜头前根本没有人"误报成"代码读错键名" ——
      //   假摄像头（色块）就是这个情形，实测 179 帧里 poseLandmarks 一次都没出现。
      const poseWorks = this.seenKeys.has('poseLandmarks');
      if (poseWorks && this.framesWithoutWorld > 60) {
        if (this.worldFieldSeen !== false) {
          this.worldFieldSeen = false;
          this.onError(
            new Error(
              `连续 ${this.framesWithoutWorld} 帧都没拿到世界坐标流（探测过 za 与 poseWorldLandmarks）。` +
                `已见到的字段：${this.resultKeys.join(', ') || '(空)'}。` +
                `世界坐标是 Kalidokit 的必需输入（且必须是米制），缺了整条重定向链都不会运行 ——` +
                `但覆盖层照样会画身体点，所以看起来像"识别到了却没数据"。`,
            ),
          );
        }
      }
    }

    const pose = toLandmarks(results.poseLandmarks);
    // ★ 优先 za（实测的本版本键名），回退 poseWorldLandmarks
    const world = toLandmarks(results.za ?? results.poseWorldLandmarks);
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

  /** 已完成的推理帧数（诊断用：为 0 说明帧循环根本没跑起来） */
  get framesProcessed(): number {
    return this.framesProcessedCount;
  }

  private framesProcessedCount = 0;

  /**
   * Holistic 返回过哪些键（自检用）。
   *
   * ★ 加这个是因为踩了一个很贵的坑：
   *   @mediapipe/holistic 的世界坐标流**叫 `za`**（内部 stream 名是 world_landmarks），
   *   **不是 `poseWorldLandmarks`** —— 它的 index.d.ts 里 `Results` 接口只写了
   *   poseLandmarks / faceLandmarks / hands / segmentationMask / image，根本没提世界坐标。
   *
   *   读错键名的后果是链式的，而且全程不报错：
   *     world = undefined → isBodyTracked() 恒 false → 校准检测率恒 0
   *     → 同时 solvePose() 因 world 为 null 直接 return null，**Kalidokit 从未运行**
   *   而覆盖层只画 poseLandmarks，所以屏幕上照样有骨骼点 ——
   *   用户看到的是"能识别到点，但检测率 0"。
   */
  /** 跨帧累积见过的字段（MediaPipe 只在对应流有输出时才设置属性，单帧探测不可靠） */
  private seenKeys = new Set<string>();
  /** 至今从没出现过世界坐标字段的帧数 */
  private framesWithoutWorld = 0;
  /**
   * 世界坐标那个流**字段本身存不存在**。
   *
   * 与"有没有数据"是两件事，必须分开：
   *   · 字段不存在 → 我读错键名了（这次的 bug），必须立刻报错
   *   · 字段存在但长度为 0 → 没检到人，正常帧，不该报错
   * 混在一起就会把"没检到人"当成"代码坏了"，或者反过来把 bug 藏起来。
   */
  private worldFieldSeen: boolean | null = null;

  /**
   * 已见过的结果字段名（诊断用）。
   *
   * ★ 注意不能只用 `Object.keys(results)`：MediaPipe 的输出是**不可枚举的 getter**，
   *   Object.keys 只会返回 multiFaceGeometry 这种普通属性。
   *   必须按已知名字逐个探测 `results[name] !== undefined`。
   */
  get resultKeys(): string[] {
    return [...this.seenKeys];
  }

  /** 世界坐标字段是否可用（null = 还没收到过结果） */
  get worldFieldAvailable(): boolean | null {
    return this.worldFieldSeen;
  }

  /**
   * 身体点是否曾经出现过。
   * 与 worldFieldAvailable 配合使用：只有在"身体点能拿到"的前提下，
   * "没有世界坐标"才是结构性问题；否则只是镜头前没人。
   */
  get poseFieldAvailable(): boolean {
    return this.seenKeys.has('poseLandmarks');
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

'use client';

/**
 * 摄像头区：设备选择、启动/关闭、视频、关键点覆盖层、识别状态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么这一段单独成组件，而不是塞进页面
 * ══════════════════════════════════════════════════════════════════════════
 *  覆盖层要按推理帧率重画（最多 30Hz），而重画需要触发 React 更新。
 *  如果它和整个页面在同一个组件里，那 30Hz 的重渲染会把 VRM 预览、动作列表、
 *  裁剪条全都重算一遍。所以把「会高频更新的部分」单独隔离在这里 ——
 *  它自己持有 video/overlay/帧计数，页面只通过 onFrame 拿它需要的原始数据。
 *
 *  另外把视频元素的**显示镜像**与**模型输入**分开：
 *    · <video> 用 CSS scaleX(-1) 镜像（符合自拍习惯）
 *    · 送进 MediaPipe 的是元素像素，CSS 变换不影响像素数据，所以模型输入未镜像
 *    · <canvas> 用同一套视觉变换来画点，保证与画面里的自己对齐；
 *      canvas **不做** CSS 镜像，这样将来在画面上写调试文字不会被写反
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HolisticSession, type HolisticFrame, type SessionStatus } from '@/lib/mocap/holistic-session';
import type { HolisticConnections } from '@/lib/mocap/holistic-session';
import type { Landmark } from '@/lib/mocap/mocap-types';
import LandmarkOverlay, { type OverlayLayers } from './landmark-overlay';
import { checkVendorFiles, REQUIRED_VENDOR_FILES } from '@/lib/mocap/mediapipe-assets';
import { describeCameraError } from '@/lib/mocap/camera-errors';

export interface CameraFramePayload {
  frame: HolisticFrame;
  video: HTMLVideoElement;
}

export interface CameraCaptureHandle {
  session: HolisticSession | null;
  video: HTMLVideoElement | null;
  start(): Promise<void>;
  getOverlayCanvas(): HTMLCanvasElement | null;
}

interface Props {
  onFrame: (payload: CameraFramePayload) => void;
  onStatus?: (status: SessionStatus, detail: string) => void;
  onError?: (msg: string) => void;
  /** 页面需要在录制时冻结某些开关（例如不允许录制中改图层） */
  locked?: boolean;
  handleRef?: React.MutableRefObject<CameraCaptureHandle | null>;
}

const VIDEO_W = 640;
const VIDEO_H = 480;

const FLOW_LABEL = { pose: '身体点', world: '世界坐标', hands: '手部', face: '面部' } as const;

/**
 * 每个数据流的"缺了会怎样"。
 * 写在界面上而不是只写在代码注释里 —— 这几个字段缺任何一个，
 * 表现出来的都是"看起来在动但其实没数据"，不指明原因很难查。
 */
function hintFor(k: 'pose' | 'world' | 'hands' | 'face'): string {
  switch (k) {
    case 'pose':
      return '归一化身体关键点（33 点）。覆盖层画的就是它；缺了画面上什么都没有。';
    case 'world':
      return '世界坐标（米）。★ Kalidokit 的必需输入，且必须是米制 —— 喂归一化坐标会让整条手臂被丢弃。在 Holistic 里这个流的键名叫 za，不叫 poseWorldLandmarks。';
    case 'hands':
      return '左右手 21 点。只用于提高手腕置信度与覆盖层显示；G2 不驱动手指。';
    case 'face':
      return '468 点面部网格。用于头部旋转与头颈置信度；缺了头部轨道会保持上一有效姿态。';
  }
}

export default function CameraCapture({ onFrame, onStatus, onError, locked, handleRef }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<HolisticSession | null>(null);
  const lastFrameRef = useRef<{
    pose: Landmark[] | null;
    leftHand: Landmark[] | null;
    rightHand: Landmark[] | null;
    face: Landmark[] | null;
  }>({ pose: null, leftHand: null, rightHand: null, face: null });
  const connectionsRef = useRef<HolisticConnections | null>(null);
  const resultKeysRef = useRef<string[]>([]);
  const worldFieldRef = useRef<boolean | null>(null);

  const [status, setStatus] = useState<SessionStatus>('idle');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState<Awaited<ReturnType<typeof checkVendorFiles>> | null>(null);
  const [checking, setChecking] = useState(false);
  const checkResources = useCallback(async () => {
    setChecking(true);
    const result = await checkVendorFiles();
    setVendor(result);
    setChecking(false);
    if (result.ok) setError(null);
    return result;
  }, []);

  useEffect(() => { void checkResources(); }, [checkResources]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [tick, setTick] = useState(0);
  const [fps, setFps] = useState(0);
  const [inferenceMs, setInferenceMs] = useState(0);
  const [layers, setLayers] = useState<OverlayLayers>({ pose: true, hands: true, face: false });
  const [present, setPresent] = useState<Record<'pose' | 'world' | 'hands' | 'face', boolean>>({
    pose: false,
    world: false,
    hands: false,
    face: false,
  });
  const [resultKeys, setResultKeys] = useState<string[]>([]);
  const [worldFieldAvailable, setWorldFieldAvailable] = useState<boolean | null>(null);

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // 覆盖层重画：用 rAF 节流到 ~30Hz，而不是每个推理帧都 setState
  useEffect(() => {
    if (status !== 'running') return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      setTick((n) => (n + 1) % 100000);
      const s = sessionRef.current;
      if (s) {
        setFps(s.inferenceFps);
        setInferenceMs(s.inferenceMs);
        if (resultKeysRef.current.length === 0 && s.resultKeys.length) {
          resultKeysRef.current = s.resultKeys;
          setResultKeys(s.resultKeys);
        }
        if (worldFieldRef.current === null) {
          worldFieldRef.current = s.worldFieldAvailable;
          setWorldFieldAvailable(s.worldFieldAvailable);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    if (handleRef?.current) {
      handleRef.current.session = null;
      handleRef.current.video = null;
    }
    lastFrameRef.current = { pose: null, leftHand: null, rightHand: null, face: null };
    setFps(0);
    setInferenceMs(0);
    setPresent({ pose: false, world: false, hands: false, face: false });
    setError(null);
    setStatus('stopped');
    setDetail('已关闭');
  }, [handleRef]);

  // 卸载时一定要停：否则关掉页面后摄像头指示灯还亮着（验收第 10 条）
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (id?: string) => {
      const video = videoRef.current;
      if (!video) return;
      setError(null);
      setVendor(null);
      resultKeysRef.current = [];
      worldFieldRef.current = null;
      setResultKeys([]);
      setWorldFieldAvailable(null);
      setPresent({ pose: false, world: false, hands: false, face: false });
      // 先停掉旧的，避免两条 getUserMedia 抢同一个摄像头
      sessionRef.current?.stop();

      const session = new HolisticSession({
        video,
        deviceId: id || undefined,
        onStatus: (s, d) => {
          setStatus(s);
          setDetail(d);
          onStatusRef.current?.(s, d);
        },
        onError: (e) => {
          setError(describeCameraError(e));
          onErrorRef.current?.(e.message);
        },
        onFrame: (frame) => {
          // 关键数据到位情况：每帧更新一次，缺什么一眼可见
          setPresent({
            pose: !!frame.poseLandmarks?.length,
            // ★ 世界坐标是 Kalidokit 的必需输入；它在 holistic 里叫 `za`
            world: !!frame.poseWorldLandmarks?.length,
            hands: !!(frame.leftHandLandmarks?.length || frame.rightHandLandmarks?.length),
            face: !!frame.faceLandmarks?.length,
          });
          lastFrameRef.current = {
            pose: frame.poseLandmarks,
            leftHand: frame.leftHandLandmarks,
            rightHand: frame.rightHandLandmarks,
            face: frame.faceLandmarks,
          };
          onFrameRef.current({ frame, video });
        },
      });
      sessionRef.current = session;
      if (handleRef?.current) {
        handleRef.current.session = session;
        handleRef.current.video = video;
      }

      try {
        await session.start();
        if (sessionRef.current !== session) return;
        setVendor({ ok: true, missing: [], checked: REQUIRED_VENDOR_FILES.length });
        connectionsRef.current = session.connectionsOrNull;
        // 授权后再枚举一次：首次枚举时 label 是空的（浏览器隐私限制）
        setDevices(await HolisticSession.listDevices());
      } catch (e) {
        if (sessionRef.current !== session) return;
        const resources = await checkVendorFiles();
        if (sessionRef.current !== session) return;
        setVendor(resources);
        setError(describeCameraError(e));
        setStatus('error');
      }
    },
    [handleRef],
  );

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      session: sessionRef.current,
      video: videoRef.current,
      start: () => start(deviceId),
      getOverlayCanvas: () => boxRef.current?.querySelector<HTMLCanvasElement>('canvas.mocap-overlay') ?? null,
    };
    return () => {
      handleRef.current = null;
    };
  }, [deviceId, handleRef, start]);

  useEffect(() => {
    // 初次挂载先探一下有没有摄像头（不申请权限，label 可能为空）
    HolisticSession.listDevices().then(setDevices);
  }, []);

  const getFrame = useCallback(() => lastFrameRef.current, []);

  const running = status === 'running' || status === 'starting';
  const showVideo = running;

  return (
    <div className="camera-capture">
      <div className="camera-controls">
        {!running ? (
          <button type="button" className="primary" onClick={() => start(deviceId)}>
            启动摄像头
          </button>
        ) : (
          <button type="button" className="danger" onClick={stop} disabled={locked} title={locked ? '请先停止录制' : undefined}>
            关闭摄像头
          </button>
        )}

        <label className="camera-device">
          设备
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={running || locked}>
            <option value="">默认</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `摄像头 ${i + 1}`}
              </option>
            ))}
          </select>
        </label>

        <div className="camera-layers">
          {(['pose', 'hands', 'face'] as const).map((k) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={layers[k]}
                disabled={locked}
                onChange={(e) => setLayers((p) => ({ ...p, [k]: e.target.checked }))}
              />
              {k === 'pose' ? '身体' : k === 'hands' ? '手部' : '面部'}
            </label>
          ))}
        </div>
      </div>

      <div className="camera-stage" ref={boxRef}>
        <video
          ref={videoRef}
          className={`camera-video${showVideo ? '' : ' is-hidden'}`}
          width={VIDEO_W}
          height={VIDEO_H}
          playsInline
          muted
        />
        {!showVideo && (
          <div className="camera-placeholder">
            <span className="camera-placeholder-frame" aria-hidden="true" />
            <h3>{status === 'error' ? '准备好后，再试一次' : '让影伴跟随你的动作'}</h3>
            <p>启动摄像头，站在画面中央</p>
            <p className="hint">视频仅用于本地动作识别</p>
          </div>
        )}
        {showVideo && (
          <LandmarkOverlay
            getFrame={getFrame}
            connections={connectionsRef.current}
            layers={layers}
            width={VIDEO_W}
            height={VIDEO_H}
            frameTick={tick}
          />
        )}
      </div>

      <div className="camera-status">
        <span className={`badge status-${status}`}>
          {status === 'idle' && '未启动'}
          {status === 'starting' && `启动中：${detail}`}
          {status === 'running' && '识别中'}
          {status === 'stopped' && '已关闭'}
          {status === 'error' && '错误'}
        </span>
        <span>
          推理 <strong>{fps > 0 ? fps.toFixed(1) : '—'}</strong> fps
        </span>
        <span className="camera-resource-status">{checking ? '检查模型资源…' : vendor?.ok ? '本地模型已就绪' : vendor ? '模型资源待修复' : '准备模型中'}</span>
      </div>

      {vendor && !vendor.ok ? (
        <div className="camera-error" role="alert">
          <strong>动作识别资源尚未准备好</strong>
          <p>请重新启动开发服务，让它自动补齐本地模型，然后重新检测。</p>
          <button type="button" onClick={() => void checkResources()} disabled={checking}>{checking ? '检测中…' : '重新检测资源'}</button>
          <details><summary>查看修复方法与缺失文件（{vendor.missing.length}）</summary>
            <p>在仓库根目录执行 <code>node tools/sync-mediapipe.mjs</code>，或在 web 目录重新运行 <code>npm run dev</code>。</p>
            <pre>{vendor.missing.join('\n')}</pre>
          </details>
        </div>
      ) : error && <div className="camera-error" role="alert"><strong>摄像头暂时不可用</strong><p>{error}</p><span className="hint">调整后点击上方“启动摄像头”重试。</span></div>}

      <details className="advanced-panel camera-diagnostics">
        <summary><span>识别诊断</span><span className="summary-note">关键点 · 性能 · 图例</span></summary>
        <div className="camera-status"><span>单帧 {inferenceMs > 0 ? `${inferenceMs.toFixed(0)}ms` : '—'}</span>
        <span className="hint">
          帧回调 {sessionRef.current?.usingVideoFrameCallback ? 'rVFC' : 'rAF/—'}
        </span>
      </div>

      <div className="camera-dataflow">
        <span className="hint">数据到位：</span>
        {(['pose', 'world', 'hands', 'face'] as const).map((k) => {
          const ok = present[k];
          // 世界坐标要区分两种情况：字段不存在（代码 bug，必须报错）
          // vs 字段在但没有数据（没检到人，正常）
          const fieldMissing = k === 'world' && worldFieldAvailable === false;
          const cls = ok ? 'flow-ok' : fieldMissing ? 'flow-missing' : 'flow-empty';
          const mark = ok ? '✓' : fieldMissing ? '✗' : '·';
          const suffix = k === 'world' && fieldMissing ? '（字段缺失！）' : ok ? '' : '（无数据）';
          return (
            <span key={k} className={cls} title={hintFor(k)}>
              {mark} {FLOW_LABEL[k]}
              {suffix}
            </span>
          );
        })}
        {resultKeys.length > 0 && (
          <span className="hint mono" title="Holistic 实际返回的键名">
            返回键: {resultKeys.filter((k) => k !== 'image').join(', ')}
          </span>
        )}
      </div>

      <div className="camera-legend">
        <span><i style={{ background: '#4dabf7' }} />身体</span>
        <span><i style={{ background: '#51cf66' }} />左手</span>
        <span><i style={{ background: '#ff922b' }} />右手</span>
        <span><i style={{ background: '#f2c037' }} />置信度&lt;0.5</span>
        <span><i style={{ background: '#e03131' }} />严重丢失</span>
      </div>

      <p className="hint">预览为镜像；模型接收原始画面，覆盖层与视频使用相同缩放。</p>
      </details>
    </div>
  );
}

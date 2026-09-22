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

export interface CameraFramePayload {
  frame: HolisticFrame;
  video: HTMLVideoElement;
}

export interface CameraCaptureHandle {
  session: HolisticSession | null;
  video: HTMLVideoElement | null;
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

  const [status, setStatus] = useState<SessionStatus>('idle');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [tick, setTick] = useState(0);
  const [fps, setFps] = useState(0);
  const [inferenceMs, setInferenceMs] = useState(0);
  const [layers, setLayers] = useState<OverlayLayers>({ pose: true, hands: true, face: false });

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

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
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    if (handleRef) handleRef.current = { session: null, video: null };
    lastFrameRef.current = { pose: null, leftHand: null, rightHand: null, face: null };
    setFps(0);
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
      // 先停掉旧的，避免两条 getUserMedia 抢同一个摄像头
      sessionRef.current?.stop();

      const session = new HolisticSession({
        video,
        deviceId: id || undefined,
        onStatus: (s, d) => {
          setStatus(s);
          setDetail(d);
          onStatus?.(s, d);
        },
        onError: (e) => {
          setError(e.message);
          onError?.(e.message);
        },
        onFrame: (frame) => {
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
      if (handleRef) handleRef.current = { session, video };

      try {
        await session.start();
        connectionsRef.current = session.connectionsOrNull;
        // 授权后再枚举一次：首次枚举时 label 是空的（浏览器隐私限制）
        setDevices(await HolisticSession.listDevices());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    },
    [handleRef, onError, onStatus],
  );

  useEffect(() => {
    // 初次挂载先探一下有没有摄像头（不申请权限，label 可能为空）
    HolisticSession.listDevices().then(setDevices);
  }, []);

  const getFrame = useCallback(() => lastFrameRef.current, []);

  const running = status === 'running' || status === 'starting';
  const showVideo = running || status === 'stopped';

  return (
    <div className="camera-capture">
      <div className="camera-controls">
        {!running ? (
          <button type="button" className="primary" onClick={() => start(deviceId)}>
            启动摄像头
          </button>
        ) : (
          <button type="button" className="danger" onClick={stop}>
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

      <div className="camera-stage" ref={boxRef} style={{ width: VIDEO_W, height: VIDEO_H }}>
        <video
          ref={videoRef}
          className={`camera-video${showVideo ? '' : ' is-hidden'}`}
          width={VIDEO_W}
          height={VIDEO_H}
          playsInline
          muted
          style={{ width: VIDEO_W, height: VIDEO_H, transform: 'scaleX(-1)' }}
        />
        {!showVideo && (
          <div className="camera-placeholder">
            <p>摄像头未启动</p>
            <p className="hint">画面会镜像显示（自拍习惯）；送进模型的关键点不镜像</p>
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
        <span>单帧 {inferenceMs > 0 ? `${inferenceMs.toFixed(0)}ms` : '—'}</span>
        <span className="hint">
          帧回调 {sessionRef.current?.usingVideoFrameCallback ? 'rVFC' : 'rAF/—'}
        </span>
      </div>

      <div className="camera-legend">
        <span><i style={{ background: '#4dabf7' }} />身体</span>
        <span><i style={{ background: '#51cf66' }} />左手</span>
        <span><i style={{ background: '#ff922b' }} />右手</span>
        <span><i style={{ background: '#f2c037' }} />置信度&lt;0.5</span>
        <span><i style={{ background: '#e03131' }} />严重丢失</span>
      </div>

      {error && (
        <div className="camera-error" role="alert">
          <strong>摄像头/模型出错</strong>
          <pre>{error}</pre>
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * /motion-library 的编排层。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  数据方向是单向的，不要反过来
 * ══════════════════════════════════════════════════════════════════════════
 *  实时：
 *    HolisticSession → MocapRawFrame → KalidokitSolver → RetargetProfile
 *      → 校准 + 平滑 → CharacterRuntime（唯一写骨骼的地方）
 *
 *  停止录制后：
 *    RecordedFrame[] → ClipBuilder → ClipFile v1 → validateClipFile → ClipPlayer
 *
 *  **组件不得直接计算 VRM 骨骼旋转**（计划 §十一）。本文件只做编排与命名，
 *  所有数学都在 lib/mocap/ 的纯模块里，这样每一段都能离线单测。
 *
 *  录制**不经过 ClipPlayer**：重定向后的实时姿态直传给 runtime。
 *  停止后才切到 ClipPlayer 回放正式 clip —— 保证"最终看到的"与"动作库里播放的"
 *  必然是同一个东西。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CameraCapture, { type CameraCaptureHandle, type CameraFramePayload } from './camera-capture';
import AvatarSelect from '@/components/avatar-select';
import MocapVrmPreview, { type MocapPreviewHandle } from './mocap-vrm-preview';
import ClipTrimmer from './clip-trimmer';
import MotionList from './motion-list';
import { baseQuatOf } from '@/lib/pose';
import type { Pose } from '@/lib/pose';
import {
  RETARGET_TARGET_BONES,
  RETARGET_IS_MEASURED,
  RETARGET_PROFILE_ID,
  buildHandsInput,
  handSideFor,
  retarget,
  swapLeftRight as DEFAULT_SWAP,
} from '@/lib/mocap/retarget-profile';
import {
  CalibrationSession,
  applyCalibration,
  type CalibrationOutcome,
  CALIBRATION_CORRECTION_OBSERVED_DEG,
} from '@/lib/mocap/calibration';
import { PoseSmoother, computeBoneConfidence, isBodyTracked } from '@/lib/mocap/smoothing';
import { RecordingSession, type RecordingOutcome } from '@/lib/mocap/recording';
import { buildClip, type BuildClipResult } from '@/lib/mocap/clip-builder';
import { MOCAP_LIMITS, type MocapRawFrame } from '@/lib/mocap/mocap-types';
import { DiagnosticRecorder } from '@/lib/mocap/diagnostic-recorder';
import type { DiagnosticTrace } from '@/lib/mocap/diagnostic-recorder';
import { HOLISTIC_OPTIONS, MEDIAPIPE_HOLISTIC_VERSION } from '@/lib/mocap/mediapipe-assets';
import {
  createKalidokitSolver,
  KALIDOKIT_VERSION,
  probeRestingDefaultGuard,
  type MocapSolver,
} from '@/lib/mocap/kalidokit-solver';
import PageHeading from '@/components/page-heading';
import { stateAfterCameraStatus, type MachineState } from '@/lib/mocap/capture-state';
export type { MachineState } from '@/lib/mocap/capture-state';
import {
  fetchCatalog,
  loadClipFile,
  importClipFromFile,
  type ClipCatalogEntry,
} from '@/lib/clip-catalog';
import { validateClipFile } from '@/lib/contracts';
import { HUMAN_BONES_VRM1 as HUMAN_BONES } from '@/lib/contracts';
import type { ClipFile } from '@/lib/clip-spec';

const STATE_LABEL: Record<MachineState, string> = {
  'camera-off': '等待启动摄像头',
  'loading-model': '加载模型',
  detecting: '识别中',
  calibrating: '校准中',
  ready: '就绪',
  countdown: '倒计时',
  recording: '录制中',
  processing: '处理中',
  reviewing: '预览与裁剪',
  saving: '保存中',
  error: '出错',
};

/**
 * 全部目标骨骼的基础站姿（缺省 identity）。
 * 含 30 根手指 —— 它们的基础站姿就是伸直（identity），正好对应"手指自然伸展"。
 */
function basePoseAll(): Pose {
  const out: Pose = {};
  for (const b of RETARGET_TARGET_BONES) out[b] = baseQuatOf(b);
  return out;
}

const DEFAULT_AVATAR = '/avatars/sample.vrm';
const SECOND_AVATAR = '/avatars/compat.vrm';
const COUNTDOWN_FROM = 3;
/** 左栏（摄像头）默认宽度占比：右侧影伴预览是主角，默认给 62% */
const DEFAULT_SPLIT = 38;
const SPLIT_STORAGE_KEY = 'mocap-split';
const SPLIT_MIN = 20;
const SPLIT_MAX = 70;

export default function MotionLibraryPage() {
  // ── 状态机 ───────────────────────────────────────────────────────────
  const [state, setState] = useState<MachineState>('camera-off');
  const stateRef = useRef<MachineState>('camera-off');
  const setStateBoth = useCallback((s: MachineState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // ── UI 状态 ──────────────────────────────────────────────────────────
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);
  const [calibration, setCalibration] = useState<CalibrationOutcome | null>(null);
  const [calibProgress, setCalibProgress] = useState(0);
  const [recOutcome, setRecOutcome] = useState<RecordingOutcome | null>(null);
  const [recLive, setRecLive] = useState({ ms: 0, frames: 0, valid: 0, lostMs: 0 });
  const [trim, setTrim] = useState({ inMs: 0, outMs: 0 });
  const [built, setBuilt] = useState<BuildClipResult | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [swap, setSwap] = useState<boolean>(DEFAULT_SWAP);
  const [displayName, setDisplayName] = useState('真人动作');
  const [requestedId, setRequestedId] = useState('');
  const [twoChars, setTwoChars] = useState(false);
  // 主角色可换（用哪个角色演示动作）；对照角色只在"双角色对比"时才会用到。
  const [primaryAvatar, setPrimaryAvatar] = useState(DEFAULT_AVATAR);
  const [secondAvatar, setSecondAvatar] = useState(SECOND_AVATAR);
  const [entries, setEntries] = useState<ClipCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [clipSnapshot, setClipSnapshot] = useState({ state: 'idle', time: 0, duration: 0 });
  const [skeleton, setSkeleton] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeLabel, setProbeLabel] = useState('抬右手');
  const [probeResult, setProbeResult] = useState<ProbeSummary | null>(null);

  // ── 左右分栏（摄像头 | 影伴预览）──────────────────────────────────────
  // split 是左栏宽度百分比；右侧影伴预览拿走剩余空间（它是主角）。
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= SPLIT_MIN && saved <= SPLIT_MAX) setSplit(saved);
    } catch {
      /* 隐私模式下 localStorage 不可用，用默认值即可 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, split.toFixed(1));
    } catch {
      /* 同上，忽略 */
    }
  }, [split]);

  const startSplitDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    if (!grid || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const rect = grid.getBoundingClientRect();
    handle.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct)));
    };
    const onUp = () => {
      handle.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onMove);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, []);

  const onSplitKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setSplit((s) => Math.max(SPLIT_MIN, s - 2));
    else if (e.key === 'ArrowRight') setSplit((s) => Math.min(SPLIT_MAX, s + 2));
    else return;
    e.preventDefault();
  }, []);

  // ── 管线对象（用 ref：每帧都要访问，不能走 state）────────────────────
  const solverRef = useRef<MocapSolver | null>(null);
  const smootherRef = useRef<PoseSmoother | null>(null);
  const calibrationRef = useRef<CalibrationSession | null>(null);
  const recordingRef = useRef<RecordingSession | null>(null);
  const correctionsRef = useRef<Pose | null>(null);
  /**
   * ★ 是否跳过校准。**默认开**。
   *
   * 实测：修正量**不能泛化** —— 用 90°（自然下垂）标定后，0°（T-pose）会被映射到
   * 偏离 identity 108° 的位置。也就是说这套修正量只让"标定那一帧"变准，
   * 其它姿态反而更偏。用户的实机观察与此一致："没有校准的时候人物跟随反而是对的"。
   *
   * 所以默认跳过。校准通路完整保留（关掉这个开关即可），等上臂 x/y 的轴映射
   * 按真人逐条实测修好之后再切回默认开启。
   */
  const [skipCalibration, setSkipCalibration] = useState(true);
  const [diagnosticStatus, setDiagnosticStatus] = useState<'idle' | 'preparing' | 'recording' | 'saving' | 'saved' | 'error'>('idle');
  const [diagnosticElapsed, setDiagnosticElapsed] = useState(0);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticSaved, setDiagnosticSaved] = useState<{ id: string; path: string; relativePath: string } | null>(null);
  const diagnosticRef = useRef<DiagnosticRecorder | null>(null);
  const pendingDiagnosticRef = useRef<{ video: Blob; trace: DiagnosticTrace } | null>(null);
  const skipCalibrationRef = useRef(true);
  const lastFrameAtRef = useRef(0);
  const previewRef = useRef<MocapPreviewHandle | null>(null);
  const cameraRef = useRef<CameraCaptureHandle | null>(null);
  const clipsRef = useRef<Map<string, ClipFile>>(new Map());
  /**
   * 录制期间的**原始关键点**。
   * 与 RecordingSession 里那份（处理后姿态）平行存：
   *   · 处理后姿态用来烘 clip
   *   · 原始关键点用来以后重调滤波/重定向（clip 里的四元数已丢失推导过程）
   * 只存内存，随保存请求发出；体积大（10 秒可能 5–10 MB），不落 localStorage。
   */
  const rawFramesRef = useRef<MocapRawFrame[]>([]);

  /**
   * 上一帧的管线诊断。
   *
   * 这类"某一路数据没到位"的故障，从画面上只能看出"某某不动"，
   * 但原因可能在四五个环节之一。把它记下来，一次就能定位：
   * 手部关键点到了吗 → 解算出了吗 → 重定向产出几根 → 写进骨骼成功吗。
   */
  const pipelineRef = useRef({
    handLandmarks: { left: 0, right: 0 },
    handSolved: { Left: false, Right: false },
    retargetProduced: 0,
    retargetMissingFingers: [] as string[],
    applied: 0,
    applyError: null as string | null,
  });

  /**
   * 标定探针。
   *
   * 目的：把"哪个分量在动、往哪个方向动"从**观察**变成**数字**。
   * 轴向映射不能靠推导（Kalidokit 的 rig 空间里有左右反向、非线性耦合、clamp），
   * 但也不该靠"看着像反了"来猜 —— 让用户做一个动作、把范围打出来，
   * 照着数字改常量，一次到位。
   *
   * 记录的是**重定向前**的原始输出（Kalidokit 的 kp / kf），
   * 因为要判断的正是"原始值到目标骨骼"这一步。
   */
  const probeRef = useRef<{
    startedAt: number;
    samples: Record<string, Record<string, number[]>>;
  } | null>(null);
  const swapRef = useRef(swap);
  swapRef.current = swap;

  const base = useMemo(basePoseAll, []);

  // ── 动作目录 ─────────────────────────────────────────────────────────
  const refreshCatalog = useCallback(async () => {
    try {
      const list = await fetchCatalog();
      setEntries(list);
      return list;
    } catch (e) {
      setNotice({ kind: 'error', text: `动作目录读取失败：${e instanceof Error ? e.message : e}` });
      return [];
    }
  }, []);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  // ── 求解器（动态 import，避免把 kalidokit 打进首屏）──────────────────
  useEffect(() => {
    let cancelled = false;
    createKalidokitSolver()
      .then((s) => {
        if (!cancelled) solverRef.current = s;
      })
      .catch((e) => setNotice({ kind: 'error', text: `Kalidokit 加载失败：${e?.message ?? e}` }));
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 切换左右映射会**作废校准**。
   *
   * 因为修正量是按当时的映射算出来的：Qcorrection = Qbase × inverse(Qneutral)，
   * 而 Qneutral 来自「哪个 Kalidokit 键驱动哪根骨骼」。
   * 换了映射还用旧修正量，等于把错误偏移叠在新映射上 ——
   * 表现就是"左右对了但上下反了"这种局部看起来没道理的现象。
   */
  useEffect(() => {
    correctionsRef.current = null;
    setCalibration(null);
    smootherRef.current?.reset();
    if (stateRef.current === 'ready' || stateRef.current === 'calibrating') {
      setStateBoth('detecting');
    }
    if (stateRef.current !== 'camera-off') {
      setNotice({ kind: 'warn', text: '左右映射已切换，请重新校准（1.5 秒）' });
    }
    // 只应在 swap 变化时触发，不要依赖其它状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swap]);

  const ensureSmoother = useCallback(() => {
    if (!smootherRef.current) smootherRef.current = new PoseSmoother({ basePose: base });
    return smootherRef.current;
  }, [base]);

  /**
   * 切到 ClipPlayer 回放**生成的正式 clip**。
   *
   * 刻意不用实时姿态继续显示：否则"最终看到的"与"动作库里播放的"可能是两个东西，
   * 而验收要求它们一致。定义在 handleFrame 之前是因为 stopRecording 会用到它
   * （函数声明会提升，const + useCallback 不会）。
   */
  const replayBuilt = useCallback((clip: ClipFile) => {
    previewRef.current?.playClip(clip, { loop: true }).catch(() => {
      /* 被新播放取代属正常取消 */
    });
  }, []);

  // ── ★ 每帧管线 ───────────────────────────────────────────────────────
  const handleFrame = useCallback(
    ({ frame, video }: CameraFramePayload) => {
      const solver = solverRef.current;
      const preview = previewRef.current;
      const now = frame.timestampMs;
      const dt = lastFrameAtRef.current ? Math.min(100, now - lastFrameAtRef.current) : 16.7;
      lastFrameAtRef.current = now;

      const tracked = isBodyTracked(frame);
      const confidence = computeBoneConfidence(frame, swapRef.current);

      // 1) 解算。lm3d 必须是 world landmarks（米），否则会被离屏守卫打回 RestingDefault
      const imageSize = { width: video.videoWidth || 640, height: video.videoHeight || 480 };
      const kp = solver?.solvePose(frame.poseLandmarks, frame.poseWorldLandmarks, { imageSize }) ?? null;
      const kf = solver?.solveFace(frame.faceLandmarks, { imageSize }) ?? null;

      // 手部：走**独立**的 HandSolver 通路（16 关节/手，含腕部自转）。
      // ★ 用 buildHandsInput 装桶，桶名与 `from` 前缀同源 ——
      //   之前这里自己拼 {left, right}，而键前缀是 Right*/Left*，于是永远查不到，
      //   表现为"手指完全不动"且不报错。
      const hands = solver
        ? buildHandsInput(
            solver.solveHand(frame.rightHandLandmarks, handSideFor('right')),
            solver.solveHand(frame.leftHandLandmarks, handSideFor('left')),
          )
        : null;

      // 1.5) 标定探针采样（记录**重定向前**的原始输出）
      const probe = probeRef.current;
      if (probe) {
        const push = (src: Record<string, unknown> | null | undefined, prefix = '') => {
          if (!src) return;
          for (const [k, v] of Object.entries(src)) {
            if (!v || typeof v !== 'object') continue;
            const o = v as Record<string, unknown>;
            if (typeof o.x !== 'number' || typeof o.y !== 'number' || typeof o.z !== 'number') continue;
            const key = prefix + k;
            const slot = (probe.samples[key] ??= { x: [], y: [], z: [] });
            slot.x.push(o.x as number);
            slot.y.push(o.y as number);
            slot.z.push(o.z as number);
          }
        };
        push(kp as Record<string, unknown> | null);
        push(kf as Record<string, unknown> | null, 'Face.');
        push(hands?.Left as Record<string, unknown> | null, 'L.');
        push(hands?.Right as Record<string, unknown> | null, 'R.');
      }

      // 2) 重定向 → 规范化姿态（40 根：上半身 + 头 + 腕 + 30 根手指）
      const rt = retarget({ pose: kp, face: kf, hands }, swapRef.current);
      pipelineRef.current = {
        handLandmarks: {
          left: frame.leftHandLandmarks?.length ?? 0,
          right: frame.rightHandLandmarks?.length ?? 0,
        },
        handSolved: { Left: !!hands?.Left, Right: !!hands?.Right },
        retargetProduced: Object.keys(rt.pose).length,
        retargetMissingFingers: rt.missing.filter((b) => b.includes('Index') || b.includes('Middle') || b.includes('Ring') || b.includes('Little') || b.includes('Thumb')),
        applied: 0,
        applyError: null,
      };

      // 3) 校准采样（用**未修正**的 canonical —— 修正量正是从它算出来的）
      if (stateRef.current === 'calibrating') {
        const cal = calibrationRef.current;
        if (cal) {
          cal.add({ timestampMs: now, tracked, confidence, canonical: rt.pose });
          setCalibProgress(cal.progress);
          if (cal.isDone) finishCalibration();
        }
      }

      // 4) 应用校准
      const corrections = correctionsRef.current;
      const calibrated = corrections ? applyCalibration(rt.pose, corrections) : rt.pose;

      // 5) 平滑 + 低置信度三级回退
      const smoother = ensureSmoother();
      const smoothed = smoother.update(calibrated, confidence, now, dt);

      // 6) 实时驱动预览（顺便记下"写进骨骼"这一步的结果）
      preview?.setLivePose(smoothed.pose);
      const st = preview?.getStatus();
      if (st) {
        pipelineRef.current.applied = Object.keys(smoothed.pose).length;
        pipelineRef.current.applyError = st.applyError;
      }

      diagnosticRef.current?.append({
        timestampMs: now,
        raw: {
          poseLandmarks: frame.poseLandmarks,
          poseWorldLandmarks: frame.poseWorldLandmarks,
          leftHandLandmarks: frame.leftHandLandmarks,
          rightHandLandmarks: frame.rightHandLandmarks,
        },
        solver: { pose: kp, faceHead: kf?.head ?? null, hands },
        retarget: rt,
        output: smoothed,
        confidence,
        tracked,
        inferenceMs: frame.inferenceMs,
        rendererApplyError: st?.applyError ?? null,
      });

      // 7) 录制缓冲
      const rec = recordingRef.current;
      if (rec?.isRecording) {
        rec.add({ timestampMs: now, pose: smoothed.pose, tracked, lostBones: smoothed.lost });
        // 原始关键点平行保存（frame 里已经是可空口径，可直接序列化）
        rawFramesRef.current.push({
          timestampMs: now,
          poseLandmarks: frame.poseLandmarks,
          poseWorldLandmarks: frame.poseWorldLandmarks,
          leftHandLandmarks: frame.leftHandLandmarks,
          rightHandLandmarks: frame.rightHandLandmarks,
          faceLandmarks: frame.faceLandmarks,
        });
        const s = rec.stats();
        setRecLive({
          ms: s.durationMs,
          frames: s.frameCount,
          valid: s.validFrameRatio,
          lostMs: s.longestTrackingGapMs,
        });
        if (rec.isFull) stopRecording();
      }
    },
    // finishCalibration / stopRecording 用 ref 转发，避免把这个回调做成每帧重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ensureSmoother],
  );

  const uploadDiagnostic = useCallback(async (capture: { video: Blob; trace: DiagnosticTrace }) => {
    setDiagnosticStatus('saving');
    setDiagnosticError(null);
    pendingDiagnosticRef.current = capture;
    try {
      const extension = capture.video.type.startsWith('video/mp4') ? 'mp4' : 'webm';
      const form = new FormData();
      form.append('video', capture.video, `comparison.${extension}`);
      form.append('trace', new Blob([JSON.stringify(capture.trace)], { type: 'application/json' }), 'trace.json');
      const response = await fetch('/api/mocap-diagnostics', { method: 'POST', body: form });
      const result = await response.json() as { ok: boolean; id?: string; path?: string; relativePath?: string; error?: string };
      if (!response.ok || !result.ok || !result.id || !result.path || !result.relativePath) {
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      pendingDiagnosticRef.current = null;
      setDiagnosticSaved({ id: result.id, path: result.path, relativePath: result.relativePath });
      setDiagnosticStatus('saved');
    } catch (error) {
      setDiagnosticError(error instanceof Error ? error.message : String(error));
      setDiagnosticStatus('error');
    }
  }, []);

  const startDiagnostic = useCallback(async () => {
    if (diagnosticRef.current || pendingDiagnosticRef.current) return;
    setDiagnosticStatus('preparing');
    setDiagnosticError(null);
    setDiagnosticSaved(null);
    setDiagnosticElapsed(0);
    try {
      const camera = cameraRef.current;
      if (!camera) throw new Error('摄像头组件尚未就绪，请稍后重试。');
      if (!camera.session?.isRunning) await camera.start();

      const deadline = performance.now() + 15_000;
      let sources: { video: HTMLVideoElement; overlay: HTMLCanvasElement; avatar: HTMLCanvasElement } | null = null;
      while (performance.now() < deadline) {
        const video = cameraRef.current?.video;
        const overlay = cameraRef.current?.getOverlayCanvas();
        const avatar = previewRef.current?.getCanvas();
        if (cameraRef.current?.session?.isRunning && video?.videoWidth && overlay && avatar &&
            previewRef.current?.getStatus().slots.length && solverRef.current) {
          sources = { video, overlay, avatar };
          break;
        }
        if (cameraRef.current?.session?.currentStatus === 'error') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!sources) throw new Error('摄像头、识别模型或 3D 角色尚未就绪，请确认画面正常后重试。');
      previewRef.current?.setMode('live');
      const smoother = ensureSmoother();
      diagnosticRef.current = new DiagnosticRecorder(sources, {
        cameraWidth: sources.video.videoWidth,
        cameraHeight: sources.video.videoHeight,
        previewMirrored: true,
        modelInputMirrored: false,
        avatarUrl: primaryAvatar,
        secondAvatarUrl: twoChars ? secondAvatar : null,
        swapLeftRight: swap,
        calibrationSkipped: skipCalibration,
        calibrationCorrections: correctionsRef.current ? { ...correctionsRef.current } : null,
        smoothing: {
          tauMs: smoother.tauMs,
          holdMs: smoother.holdMs,
          blendMs: smoother.blendMs,
          minConfidence: smoother.minConfidence,
        },
        avatarSlots: previewRef.current?.getStatus().slots ?? [],
        holisticVersion: MEDIAPIPE_HOLISTIC_VERSION,
        holisticOptions: { ...HOLISTIC_OPTIONS },
        kalidokitVersion: KALIDOKIT_VERSION,
        retargetProfile: RETARGET_PROFILE_ID,
      });
      setDiagnosticStatus('recording');
    } catch (error) {
      setDiagnosticError(error instanceof Error ? error.message : String(error));
      setDiagnosticStatus('error');
    }
  }, [ensureSmoother, primaryAvatar, secondAvatar, skipCalibration, swap, twoChars]);

  const stopDiagnostic = useCallback(async () => {
    const recorder = diagnosticRef.current;
    if (!recorder) return;
    diagnosticRef.current = null;
    setDiagnosticStatus('saving');
    try {
      const capture = await recorder.stop();
      await uploadDiagnostic(capture);
    } catch (error) {
      setDiagnosticError(error instanceof Error ? error.message : String(error));
      setDiagnosticStatus('error');
    }
  }, [uploadDiagnostic]);

  useEffect(() => {
    if (diagnosticStatus !== 'recording') return;
    const timer = setInterval(() => {
      const elapsed = diagnosticRef.current?.elapsedMs ?? 0;
      setDiagnosticElapsed(elapsed);
      if (elapsed >= 90_000) void stopDiagnostic();
    }, 250);
    return () => clearInterval(timer);
  }, [diagnosticStatus, stopDiagnostic]);

  useEffect(() => () => diagnosticRef.current?.abort(), []);

  // ── 校准 ─────────────────────────────────────────────────────────────

  /** 开/关校准。关掉时必须作废旧修正量，否则等于把偏移又叠回去。 */
  const toggleSkipCalibration = useCallback(
    (on: boolean) => {
      skipCalibrationRef.current = on;
      setSkipCalibration(on);
      correctionsRef.current = null;
      setCalibration(null);
      smootherRef.current?.reset();
      const camOn = stateRef.current !== 'camera-off' && stateRef.current !== 'loading-model';
      if (camOn && ['detecting', 'ready', 'calibrating'].includes(stateRef.current)) {
        setStateBoth(on ? 'ready' : 'detecting');
      }
      setNotice({
        kind: 'info',
        text: on
          ? '已跳过校准：直接用重定向的原始输出驱动角色（实测这条更准）'
          : '已开启校准：请保持自然站姿点「校准（1.5 秒）」',
      });
    },
    [setStateBoth],
  );

  const startCalibration = useCallback(() => {
    const cal = new CalibrationSession();
    cal.start(performance.now());
    calibrationRef.current = cal;
    setCalibration(null);
    setCalibProgress(0);
    setStateBoth('calibrating');
    setNotice({
      kind: 'info',
      text:
        `保持自然站姿 ${MOCAP_LIMITS.calibrationMs / 1000} 秒：` +
        `双臂自然下垂、目视前方、不要举手也不要转头 —— ` +
        `标定姿势不对会让整段偏移算错（表现为肘反了/举不过头顶/转头反了）。`,
    });
  }, [setStateBoth]);

  function finishCalibration() {
    const cal = calibrationRef.current;
    if (!cal) return;
    const out = cal.finish();
    setCalibration(out);
    if (out.ok) {
      correctionsRef.current = out.corrections;
      smootherRef.current?.reset();
      setStateBoth('ready');
      setNotice({
        kind: 'info',
        text: `校准完成：检测率 ${(out.detectionRate * 100).toFixed(1)}%，用了 ${out.acceptedFrames}/${out.totalFrames} 帧`,
      });
    } else {
      correctionsRef.current = null;
      setStateBoth('detecting');
      setNotice({ kind: 'warn', text: `校准未通过：${out.issues.join('；')}` });
    }
  }

  // ── 录制 ─────────────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    const rec = new RecordingSession();
    rec.start(performance.now());
    recordingRef.current = rec;
    rawFramesRef.current = [];
    setRecOutcome(null);
    setBuilt(null);
    setRecLive({ ms: 0, frames: 0, valid: 0, lostMs: 0 });
    setStateBoth('recording');
    setNotice({ kind: 'info', text: `录制中（最长 ${MOCAP_LIMITS.maxRecordingMs / 1000} 秒），停止后进入裁剪` });
  }, [setStateBoth]);

  const beginCountdown = useCallback(() => {
    if (!skipCalibrationRef.current && !correctionsRef.current) {
      setNotice({ kind: 'warn', text: '请先完成校准' });
      return;
    }
    setStateBoth('countdown');
    setCountdown(COUNTDOWN_FROM);
    let n = COUNTDOWN_FROM;
    const timer = setInterval(() => {
      n -= 1;
      setCountdown(n);
      if (n <= 0) {
        clearInterval(timer);
        startRecording();
      }
    }, 1000);
  }, [setStateBoth, startRecording]);

  function stopRecording() {
    const rec = recordingRef.current;
    if (!rec?.isRecording) return;
    const out = rec.stop(performance.now());
    recordingRef.current = null;
    setRecOutcome(out);
    setStateBoth('processing');

    if (!out.canBuildClip) {
      setStateBoth('ready');
      setNotice({
        kind: 'error',
        text: `有效帧只有 ${(out.stats.validFrameRatio * 100).toFixed(1)}%，低于 ${MOCAP_LIMITS.minValidFrameRatio * 100}%，这段录制不足以生成动作，请重录`,
      });
      return;
    }

    const inMs = 0;
    const outMs = Math.max(MOCAP_LIMITS.minTrimMs, out.stats.durationMs);
    setTrim({ inMs, outMs });
    const res = buildClip({
      name: 'pending',
      frames: out.frames,
      inMs,
      outMs,
      boneList: HUMAN_BONES,
      targetBones: HUMAN_BONES,
    });
    setBuilt(res);
    setStateBoth('reviewing');
    previewRef.current?.resetToBase();
    if (res.ok && res.clip) {
      replayBuilt(res.clip);
    } else {
      setNotice({ kind: 'error', text: `生成 clip 未通过校验：${res.issues.map((i) => i.msg).join('；')}` });
    }
  }

  // ── 裁剪变化 → 重新烘焙 + 重新回放 ───────────────────────────────────
  const applyTrim = useCallback(
    (inMs: number, outMs: number) => {
      setTrim({ inMs, outMs });
      const out = recOutcome;
      if (!out) return;
      const res = buildClip({
        name: 'pending',
        frames: out.frames,
        inMs,
        outMs,
        boneList: HUMAN_BONES,
        targetBones: HUMAN_BONES,
      });
      setBuilt(res);
      if (res.ok && res.clip) replayBuilt(res.clip);
      else setNotice({ kind: 'error', text: `裁剪后未通过校验：${res.issues.map((i) => i.msg).join('；')}` });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recOutcome, replayBuilt],
  );


  // ── 保存 ─────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!built?.ok || !built.clip || !recOutcome) return;
    setStateBoth('saving');
    setNotice(null);

    const captureIdHint = requestedId.trim() || null;
    const capture = {
      schemaVersion: 1 as const,
      id: captureIdHint ?? '',
      createdAt: new Date().toISOString(),
      durationMs: recOutcome.stats.durationMs,
      source: {
        kind: 'camera' as const,
        width: 640,
        height: 480,
        previewMirrored: true as const,
        modelInputMirrored: false as const,
        deviceLabel: null,
      },
      model: {
        name: 'mediapipe-holistic' as const,
        version: '0.5.1675471629',
        options: { selfieMode: false, modelComplexity: 1, refineFaceLandmarks: true },
      },
      solver: {
        name: 'kalidokit' as const,
        version: '1.1.5',
        profile: 'upper-body-v1',
      },
      calibration: {
        durationMs: calibration?.durationMs ?? 0,
        validFrameRatio: calibration?.detectionRate ?? 0,
        neutralPose: toTuples(calibration?.neutralPose),
        corrections: toTuples(calibration?.corrections),
      },
      quality: recOutcome.quality,
      // ★ 原始关键点：动作本体之外单独存，以后能重调滤波/重定向
      frames: rawFramesRef.current,
    };

    try {
      const res = await fetch('/api/motion-library', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestedId: requestedId.trim() || undefined,
          displayName: displayName.trim(),
          note: `摄像头录制；有效帧 ${(recOutcome.stats.validFrameRatio * 100).toFixed(1)}%`,
          // name 由服务端定为最终 id，这里只是占位（校验器要求非空）
          clip: { ...built.clip, name: 'pending' },
          capture,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        id?: string;
        entry?: ClipCatalogEntry;
        issues?: { msg: string }[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setStateBoth('reviewing');
        setNotice({
          kind: 'error',
          text: `保存失败（HTTP ${res.status}）：${data.error ?? (data.issues ?? []).map((i) => i.msg).join('；')}`,
        });
        return;
      }
      const list = await refreshCatalog();
      if (data.id) setSelectedId(data.id);
      setStateBoth('ready');
      setNotice({
        kind: 'info',
        text: `已保存为 ${data.id}（目录现有 ${list.length} 个动作）。原始关键点仅本机保留。`,
      });
    } catch (e) {
      setStateBoth('reviewing');
      setNotice({ kind: 'error', text: `保存请求失败：${e instanceof Error ? e.message : e}` });
    }
  }, [built, recOutcome, calibration, requestedId, displayName, refreshCatalog, setStateBoth]);
  // ── 动作库操作 ───────────────────────────────────────────────────────
  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  const handlePlayEntry = useCallback(
    async (id: string) => {
      try {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return;
        let clip = clipsRef.current.get(id);
        if (!clip) {
          const res = await loadClipFile(entry.url, { targetBones: entry.mask, expectedId: id });
          if (!res.ok || !res.clip) {
            setNotice({ kind: 'error', text: `动作加载失败：${res.issues.map((i) => i.msg).join('；')}` });
            return;
          }
          clip = res.clip;
          clipsRef.current.set(id, clip);
        }
        setPlayingId(id);
        setSelectedId(id);
        await previewRef.current?.playClip(clip, { loop: true });
      } catch {
        /* 被取代属正常取消 */
      }
    },
    [entries],
  );

  /**
   * 删除一条动作。
   *
   * 服务端会**同时清掉原始关键点**（data/mocap/*.landmarks.json，单段 5–10MB）。
   *
   * 删完必须**重新拉目录**，不能在本地把这条过滤掉：目录是服务端写的真相源，
   * 本地过滤会让"服务端其实没删成功"这种情况在界面上表现得像成功了。
   */
  const handleDelete = useCallback(async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/motion-library/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        removed?: string[];
        failed?: string[];
      };
      if (!res.ok) {
        setNotice({ kind: 'error', text: `删除失败（HTTP ${res.status}）：${data.error ?? '未知原因'}` });
        return;
      }
      setEntries(await fetchCatalog());
      setSelectedId((cur) => (cur === id ? '' : cur));
      const orphan = data.failed?.length ?? 0;
      setNotice({
        kind: orphan > 0 ? 'warn' : 'info',
        text:
          `已删除「${name}」` +
          (data.removed?.length ? `，清掉 ${data.removed.length} 个文件` : '') +
          (orphan > 0 ? `；有 ${orphan} 个文件没删掉（孤儿文件，不影响使用，可再删一次）` : ''),
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `删除失败：${e instanceof Error ? e.message : e}` });
    }
  }, []);

  const handleImport = useCallback(
    async (file: File) => {
      const res = await importClipFromFile(file, entries, HUMAN_BONES);
      if (!res.ok || !res.clip || !res.entry) {
        setNotice({ kind: 'error', text: `导入被拒绝：${res.issues.map((i) => i.msg).join('；')}` });
        return;
      }
      clipsRef.current.set(res.entry.id, res.clip);
      setEntries((prev) => [...prev.filter((e) => e.id !== res.entry!.id), res.entry!]);
      setSelectedId(res.entry.id);
      setNotice({
        kind: 'info',
        text: `已导入 ${res.entry.name}（仅当前会话有效；要入库请放进 web/public/clips/ 并更新 index.json）`,
      });
      // 导入的动作没有原始关键点 → captureId 为 null
    },
    [entries],
  );

  const download = useCallback((url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  // ── 快照轮询（低频，避免每帧触发重渲染）─────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      const s = previewRef.current?.getSnapshot();
      if (s) setClipSnapshot({ state: s.state, time: s.time, duration: s.duration });
    }, 120);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    previewRef.current?.setSkeletonVisible(skeleton);
  }, [skeleton]);

  // ── 调试出口（自动化验收用；都做成函数而不是快照）────────────────────
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mocapDebug = {
      getState: () => stateRef.current,
      getCalibration: () => calibration,
      getRecOutcome: () => recOutcome,
      getBuilt: () => built,
      getTrim: () => trim,
      getEntries: () => entries,
      getPreviewStatus: () => previewRef.current?.getStatus() ?? null,
      getSnapshot: () => previewRef.current?.getSnapshot() ?? null,
      getBasePose: () => base,
      isMeasured: () => RETARGET_IS_MEASURED,
      /**
       * 管线诊断。手指不动时看这个：
       *   handLandmarks 都是 0        → 手没被检到（手垂着/出画/光线暗）
       *   handSolved 是 false         → 解算失败（21 点不全）
       *   retargetProduced 远小于 40  → 来源键没对上
       *   missingFingers 非空          → 具体哪些手指缺来源
       *   applyError 非空             → 骨骼写不进去（缺骨骼）
       */
      getPipeline: () => pipelineRef.current,
      /**
       * F2 回归：验证 Kalidokit 的离屏守卫仍在、且我们喂的是米制世界坐标。
       * guardStillWorks=false 说明 kalidokit 改了行为（需要重新评估）；
       * weAreSafe=false 说明我们喂错了坐标类型（手臂会完全不动）。
       */
      probeRestingDefaultGuard,
      /** 摄像头会话诊断：帧数为 0 说明帧循环根本没跑起来（rVFC 不触发等） */
      getCameraInfo: () => {
        const s = cameraRef.current?.session;
        return s
          ? {
              status: s.currentStatus,
              detail: s.statusDetail,
              inferenceFps: s.inferenceFps,
              inferenceMs: s.inferenceMs,
              framesProcessed: s.framesProcessed,
              resultKeys: s.resultKeys,
              worldFieldAvailable: s.worldFieldAvailable,
              poseFieldAvailable: s.poseFieldAvailable,
              usingRvfc: s.usingVideoFrameCallback,
              activeTracks: s.activeTrackCount,
            }
          : null;
      },
      applyTrim,
      playEntry: handlePlayEntry,
      // ── 标定探针 ──────────────────────────────────────────────────────
      startProbe: () => {
        probeRef.current = { startedAt: performance.now(), samples: {} };
        return '探针已开始。现在做一个动作（例如抬右手 → 放下，重复 3 次），然后调用 __mocapDebug.stopProbe()';
      },
      stopProbe: () => {
        const p = probeRef.current;
        probeRef.current = null;
        if (!p) return null;
        const durationMs = performance.now() - p.startedAt;
        const bones: Record<string, Record<string, { min: number; max: number; range: number; first: number; last: number }>> = {};
        for (const [bone, axes] of Object.entries(p.samples)) {
          if (!axes.x.length) continue;
          const row: Record<string, { min: number; max: number; range: number; first: number; last: number }> = {};
          for (const [ax, vals] of Object.entries(axes)) {
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            row[ax] = {
              min: +min.toFixed(4),
              max: +max.toFixed(4),
              range: +(max - min).toFixed(4),
              first: +vals[0].toFixed(4),
              last: +vals[vals.length - 1].toFixed(4),
            };
          }
          bones[bone] = row;
        }
        const frames = Math.max(0, ...Object.values(p.samples).map((a) => a.x.length));
        return { durationMs: +durationMs.toFixed(0), frames, bones };
      },
    };
  }, [calibration, recOutcome, built, trim, entries, base, applyTrim, handlePlayEntry]);

  /**
   * 录制按钮的可点条件是**校准成功**，不是"摄像头开着"。
   * 计划原文："校准成功后允许录制"。做成禁用而不是"可点然后弹提示"，
   * 是因为禁用 + tooltip 能让人一眼看出缺哪一步，而弹提示需要先点错一次。
   */
  const calibrated = calibration?.ok === true;
  const diagnosticActive = diagnosticStatus === 'preparing' || diagnosticStatus === 'recording' || diagnosticStatus === 'saving';
  const canRecord = state === 'ready' && (skipCalibration || calibrated) && !diagnosticActive;
  const recordHint = !skipCalibration && !calibrated
    ? '需要先完成校准：点上方「校准（1.5 秒）」，保持自然站姿'
    : state !== 'ready'
      ? `当前状态：${STATE_LABEL[state]}`
      : '';
  const busy = state === 'saving' || state === 'processing' || diagnosticActive;

  return (
    <main id="main-content" className="mocap-page">
      <PageHeading eyebrow="把动作变成表达" title="动作工作室" description="捕捉你的动作，预览影伴的回应，保存为可以反复使用的动作。">
        <span className={`state-badge state-${state}`} role="status">{STATE_LABEL[state]}</span>
      </PageHeading>
      <ol className="workflow-steps" aria-label="动作录入流程">
        <li className={['camera-off', 'loading-model', 'detecting', 'error'].includes(state) ? 'is-current' : ''}><span>01</span><div><strong>连接摄像头</strong><small>站在画面中央，预览识别效果</small></div></li>
        <li className={['ready', 'calibrating', 'countdown', 'recording'].includes(state) ? 'is-current' : ''}><span>02</span><div><strong>录制动作</strong><small>倒计时后开始，最长录制 10 秒</small></div></li>
        <li className={['processing', 'reviewing', 'saving'].includes(state) ? 'is-current' : ''}><span>03</span><div><strong>裁剪与保存</strong><small>留下满意的片段，加入动作库</small></div></li>
      </ol>

      {notice && (
        <div className={`banner ${notice.kind}`}>
          {notice.text}
          <button type="button" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <div
        className="mocap-grid"
        ref={gridRef}
        style={{ '--split': `${split}%` } as React.CSSProperties}
      >
        <section className="panel control-panel">
          <div className="section-heading"><h2>录制动作</h2><span className="section-note">保持全身入镜，动作自然连贯</span></div>

          <div className="diagnostic-box">
            <div>
              <strong>动作同步诊断</strong>
              <p>一次录下摄像头、关键点和 3D 角色，并保存逐帧解算数据。点击开始会自动启动摄像头。</p>
              <p>建议依次做：右手前伸 → 左手前伸 → 手腕前后屈伸 → 双手交叉（交换前后顺序）。动作放慢，每段之间回到自然站姿。</p>
            </div>
            <div className="diagnostic-actions">
              {diagnosticStatus !== 'recording' ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => void startDiagnostic()}
                  disabled={diagnosticActive || !!pendingDiagnosticRef.current || ['recording', 'countdown', 'calibrating', 'processing', 'saving'].includes(state)}
                >
                  {diagnosticStatus === 'preparing' ? '准备中…' : '开始诊断录制'}
                </button>
              ) : (
                <button type="button" className="danger" onClick={() => void stopDiagnostic()}>
                  停止并保存
                </button>
              )}
              {diagnosticStatus === 'recording' && <span className="mono">录制中 {(diagnosticElapsed / 1_000).toFixed(1)} / 90 秒 · {diagnosticRef.current?.frameCount ?? 0} 帧</span>}
              {diagnosticStatus === 'saving' && <span>正在写入本机诊断目录…</span>}
              {pendingDiagnosticRef.current && diagnosticStatus === 'error' && (
                <button type="button" onClick={() => void uploadDiagnostic(pendingDiagnosticRef.current!)}>重试保存</button>
              )}
            </div>
            {diagnosticError && <p className="diagnostic-error" role="alert">{diagnosticError}</p>}
            {diagnosticSaved && (
              <p className="diagnostic-saved" role="status">
                已保存视频和逐帧数据：<code>{diagnosticSaved.path}</code>
              </p>
            )}
          </div>

          <div className="record-box">
            <button
              type="button"
              className="primary"
              onClick={beginCountdown}
              disabled={!canRecord}
              title={recordHint}
            >
              开始录制
            </button>
            <button
              type="button"
              className="danger"
              onClick={stopRecording}
              disabled={state !== 'recording' && state !== 'countdown'}
            >
              停止
            </button>
            {state === 'countdown' && <div className="countdown">{countdown > 0 ? countdown : '开始'}</div>}
            {state === 'recording' && (
              <div className="rec-live">
                <strong>{(recLive.ms / 1000).toFixed(1)}s</strong> / {MOCAP_LIMITS.maxRecordingMs / 1000}s
                <span>帧 {recLive.frames}</span>
                <span>有效 {(recLive.valid * 100).toFixed(0)}%</span>
                <span>最长丢失 {recLive.lostMs.toFixed(0)}ms</span>
              </div>
            )}
          </div>

          <details className="advanced-panel capture-advanced">
            <summary><span>高级设置与标定</span><span className="summary-note">校准 · 左右交换 · 探针</span></summary>
            {!RETARGET_IS_MEASURED && <div className="banner warn"><span>轴向映射尚待真人验证。若角色的动作方向不一致，可使用下方左右交换与探针进行标定。</span></div>}
          <div className="calibration-box">
            <label
              className="skip-calibration"
              title="实测：修正量不能泛化 —— 标定那一帧变准、其它姿态反而更偏。所以默认跳过校准。"
            >
              <input
                type="checkbox"
                checked={skipCalibration}
                onChange={(e) => toggleSkipCalibration(e.target.checked)}
                disabled={diagnosticActive}
              />
              跳过校准（默认，实测更准）
            </label>
            {skipCalibration && (
              <div className="hint">
                当前：<strong>未校准</strong> —— 角色直接跟随重定向输出。修正量只让标定那一帧变准，
                其它姿态反而更偏（实测：用 90° 自然下垂标定后，T-pose 会被映射到偏离 identity 108°）。
              </div>
            )}
            <button
              type="button"
              onClick={startCalibration}
              disabled={state === 'recording' || busy || skipCalibration}
            >
              校准（1.5 秒）
            </button>
            {state === 'calibrating' && (
              <progress value={calibProgress} max={1}>
                {Math.round(calibProgress * 100)}%
              </progress>
            )}
            {calibration && (
              <div className={calibration.ok ? 'ok' : 'bad'}>
                {calibration.ok
                  ? `校准通过｜检测率 ${(calibration.detectionRate * 100).toFixed(1)}%｜帧 ${calibration.acceptedFrames}/${calibration.totalFrames}｜修正量 ${calibration.maxCorrectionDeg.toFixed(1)}°（${calibration.worstBone}，正常范围 ${CALIBRATION_CORRECTION_OBSERVED_DEG.min}–${CALIBRATION_CORRECTION_OBSERVED_DEG.max}°）`
                  : `未通过：${calibration.issues.join('；')}`}
              </div>
            )}
            <label className="swap-toggle" title="切换后会自动作废校准，需要重新校准 1.5 秒">
              <input type="checkbox" checked={swap} onChange={(e) => setSwap(e.target.checked)} disabled={diagnosticActive} />
              左右交换（标定用）
            </label>
            {swap !== DEFAULT_SWAP && (
              <span className="hint">
                已偏离默认值（代码里的实测值是 {String(DEFAULT_SWAP)}）
              </span>
            )}
          </div>

          <div className="probe-row">
            <label>
              标定探针
              <select
                value={probeLabel}
                onChange={(e) => setProbeLabel(e.target.value)}
                disabled={probing || diagnosticActive}
              >
                {['抬右手', '抬左手', '屈右肘', '屈左肘', '头向自身左转', '头向自身右转', '右手前伸'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={probing ? 'danger' : ''}
              disabled={diagnosticActive || (state !== 'detecting' && state !== 'ready' && state !== 'calibrating')}
              onClick={() => {
                if (!probing) {
                  (window as unknown as { __mocapDebug?: { startProbe: () => string } }).__mocapDebug?.startProbe();
                  setProbeResult(null);
                  setProbing(true);
                  setNotice({ kind: 'info', text: `探针已开始：慢速做「${probeLabel}」并重复 3 次，做完点「结束并输出」` });
                } else {
                  const r = (
                    window as unknown as { __mocapDebug?: { stopProbe: () => ProbeSummary | null } }
                  ).__mocapDebug?.stopProbe();
                  setProbing(false);
                  setProbeResult(r ? { ...r, label: probeLabel } : null);
                  setNotice(null);
                }
              }}
            >
              {probing ? '结束并输出' : '开始'}
            </button>
            {probing && <span className="hint">采样中…慢速做动作，重复 3 次</span>}
            {!probing && <span className="hint">用它把"哪个分量在动"变成数字，不用靠看</span>}
          </div>

          {probeResult && <ProbeTable result={probeResult} />}

          </details>

          {recOutcome && (
            <div className="quality-box">
              <h3>录制质量</h3>
              <ul>
                <li>总时长 {(recOutcome.stats.durationMs / 1000).toFixed(2)}s｜帧 {recOutcome.stats.frameCount}</li>
                <li>推理帧率 {recOutcome.stats.inferenceFps.toFixed(1)} fps</li>
                <li>有效帧 {(recOutcome.stats.validFrameRatio * 100).toFixed(1)}%</li>
                <li>最长跟踪丢失 {recOutcome.stats.longestTrackingGapMs.toFixed(0)} ms</li>
              </ul>
              {recOutcome.quality.warnings.map((w, i) => (
                <div key={i} className="banner warn">
                  {w}
                </div>
              ))}
            </div>
          )}

          {built && built.stats && (
            <div className="build-box">
              <h3>生成结果</h3>
              <ul>
                <li>
                  {built.stats.frameCount} 帧 / {built.stats.duration.toFixed(2)}s @ {built.stats.fps}fps
                </li>
                <li>
                  骨骼 {built.stats.bones.length} 根：{built.stats.bones.join(', ')}
                </li>
                <li>符号连续化修正 {built.stats.signFlipsFixed} 处</li>
                <li>与选区时长偏差 {built.stats.durationDriftMs.toFixed(1)} ms</li>
              </ul>
              {!built.ok && (
                <div className="banner error">
                  校验未通过：
                  <ul>
                    {built.issues.map((i, n) => (
                      <li key={n}>
                        [{i.rule}] {i.msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel camera-panel">
          <div className="section-heading"><h2>摄像头画面</h2><span className="section-note">本地识别 · 镜像预览</span></div>
          <CameraCapture
            onFrame={handleFrame}
            handleRef={cameraRef}
            locked={state === 'recording' || state === 'countdown' || diagnosticActive}
            onStatus={(status) => {
              setStateBoth(stateAfterCameraStatus(stateRef.current, status, skipCalibrationRef.current));
            }}
          />
        </section>

        <div
          className="split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整摄像头与影伴预览的宽度"
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          title="拖动调整左右区域宽度，双击恢复默认"
          onPointerDown={startSplitDrag}
          onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
          onKeyDown={onSplitKeyDown}
        />

        <section className="panel preview-panel">
          <div className="section-heading"><h2>影伴预览</h2><span className="section-note">实时跟随与动作回放</span></div>
          <div className="preview-toolbar">
            <label>
              主角色
              <AvatarSelect ariaLabel="主角色资产" value={primaryAvatar} onChange={setPrimaryAvatar} disabled={diagnosticActive} />
            </label>
            {twoChars && (
              <label>
                对照角色
                <AvatarSelect ariaLabel="对照角色资产" value={secondAvatar} onChange={setSecondAvatar} disabled={diagnosticActive} />
              </label>
            )}
            <label>
              <input type="checkbox" checked={twoChars} onChange={(e) => setTwoChars(e.target.checked)} disabled={diagnosticActive} />
              双角色对比
            </label>
            <label>
              <input type="checkbox" checked={skeleton} onChange={(e) => setSkeleton(e.target.checked)} />
              骨架
            </label>
            <button type="button" onClick={() => previewRef.current?.pause()} disabled={diagnosticActive}>
              暂停
            </button>
            <button type="button" onClick={() => previewRef.current?.resume()} disabled={diagnosticActive}>
              继续
            </button>
            <button type="button" onClick={() => previewRef.current?.stop()} disabled={diagnosticActive}>
              停止
            </button>
            <button type="button" onClick={() => previewRef.current?.resetToBase()} disabled={diagnosticActive}>
              恢复基础站姿
            </button>
          </div>
          <MocapVrmPreview
            ref={previewRef}
            primaryUrl={primaryAvatar}
            secondUrl={secondAvatar}
            showSecond={twoChars}
            onError={(m) =>
              setNotice({
                kind: 'warn',
                text: `${m}${twoChars ? '（第二个角色需要先跑 node tools/fetch-assets.mjs）' : ''}`,
              })
            }
          />
          <div className="preview-status">
            <span>回放 {clipSnapshot.state}</span>
            <span>
              {clipSnapshot.time.toFixed(2)}s / {clipSnapshot.duration.toFixed(2)}s
            </span>
            <details className="preview-diagnostics"><summary>渲染诊断</summary><span>
              每帧 vrm.update{' '}
              {previewRef.current?.getStatus().lastFrameUpdates ?? '—'} 次
              {twoChars ? '（双角色应为 2）' : '（单角色应为 1）'}
            </span></details>
          </div>
        </section>

        <section className="panel library-panel">
          <div className="section-heading"><div><h2>已保存的动作</h2><p>选择一个动作，在上方影伴中回放。</p></div><span className="count-label">{entries.length} 个动作</span></div>
          <MotionList
            entries={entries}
            selectedId={selectedId}
            playingId={playingId}
            busy={busy}
            onSelect={handleSelect}
            onPlay={handlePlayEntry}
            onDownloadClip={(id) => {
              const e = entries.find((x) => x.id === id);
              if (e) download(e.url, `${id}.json`);
            }}
            onDownloadLandmarks={(id) => download(`/api/motion-library/${id}/landmarks`, `${id}.landmarks.json`)}
            onDelete={handleDelete}
            onImport={handleImport}
            landmarksAvailable={(id) => Boolean(entries.find((e) => e.id === id)?.captureId)}
          />
        </section>
      </div>

      {recOutcome && state === 'reviewing' && (
        <footer className="mocap-footer">
          <ClipTrimmer
            durationMs={recOutcome.stats.durationMs}
            inMs={trim.inMs}
            outMs={trim.outMs}
            onChange={applyTrim}
            outputFrames={built?.stats?.frameCount}
            outputDuration={built?.stats?.duration}
            disabled={busy}
          />
          <div className="save-row">
            <label>
              显示名
              <input
                type="text"
                value={displayName}
                maxLength={40}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <label>
              自定义 ID（可选，[a-z0-9-]）
              <input
                type="text"
                value={requestedId}
                maxLength={48}
                placeholder="mocap-YYYYMMDD-HHmmss"
                onChange={(e) => setRequestedId(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary"
              onClick={save}
              disabled={busy || !built?.ok || displayName.trim().length === 0}
            >
              {busy ? '保存中…' : '保存到动作库'}
            </button>
          </div>
          <details className="save-details"><summary>本地保存说明</summary><p className="hint">
            保存会写入 <code>web/public/clips/&lt;id&gt;.json</code> 并更新动作目录；
            原始关键点写在 <code>data/mocap/</code>（不进 git，仅本机可下载）。
            校验不通过时不会部分应用，原状态会保留。
          </p></details>
        </footer>
      )}
    </main>
  );
}

interface ProbeSummary {
  label?: string;
  durationMs: number;
  frames: number;
  bones: Record<string, Record<string, { min: number; max: number; range: number; first: number; last: number }>>;
}

/**
 * 探针结果表。
 *
 * 按**变化范围**降序排 —— 主导分量排在最上面，一眼就能看出
 * "这个动作主要由哪个分量承载、往哪个方向变"。
 * 这正是标定轴映射需要的信息，而它不该靠肉眼猜。
 */
function ProbeTable({ result }: { result: ProbeSummary }) {
  const rows = Object.entries(result.bones).flatMap(([bone, axes]) =>
    Object.entries(axes).map(([ax, s]) => ({ key: `${bone}.${ax}`, bone, ax, ...s })),
  );
  rows.sort((a, b) => b.range - a.range);
  const top = rows.filter((r) => r.range > 0.02);

  const copy = () => {
    const text = rows
      .filter((r) => r.range > 0.01)
      .map((r) => `${r.bone}.${r.ax}  范围 ${r.range.toFixed(4)}  ${r.first.toFixed(4)} → ${r.last.toFixed(4)}  [${r.min.toFixed(4)}, ${r.max.toFixed(4)}]`)
      .join(String.fromCharCode(10));
    navigator.clipboard?.writeText(`动作：${result.label}${String.fromCharCode(10)}${text}`);
  };

  return (
    <div className="probe-result">
      <div className="probe-head">
        <strong>探针结果：{result.label}</strong>
        <span className="hint">
          {result.frames} 帧 / {(result.durationMs / 1000).toFixed(1)}s｜按变化范围排序
        </span>
        <button type="button" onClick={copy}>
          复制
        </button>
      </div>
      <p className="hint">
        只看范围 &gt; 0.02 的行。带 ★ 的是主导分量 —— 它决定了这个动作该落到哪根轴、什么符号。
      </p>
      <table className="probe-table">
        <thead>
          <tr>
            <th>来源分量</th>
            <th>起始</th>
            <th>最小</th>
            <th>最大</th>
            <th>变化范围</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r, i) => (
            <tr key={r.key} className={i === 0 ? 'is-dominant' : ''}>
              <td className="mono">
                {i === 0 ? '★ ' : ''}
                {r.key}
              </td>
              <td>{r.first.toFixed(4)}</td>
              <td>{r.min.toFixed(4)}</td>
              <td>{r.max.toFixed(4)}</td>
              <td>
                <strong>{r.range.toFixed(4)}</strong>
              </td>
            </tr>
          ))}
          {top.length === 0 && (
            <tr>
              <td colSpan={5} className="motion-empty">
                几乎没有变化 —— 动作没被识别到，或者做得太小
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Pose → 可 JSON 序列化的四元数元组表 */
function toTuples(pose: Pose | undefined): Record<string, [number, number, number, number]> {
  const out: Record<string, [number, number, number, number]> = {};
  for (const [k, v] of Object.entries(pose ?? {})) out[k] = [v[0], v[1], v[2], v[3]];
  return out;
}

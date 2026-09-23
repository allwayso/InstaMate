/**
 * G2 动作采集的数据结构。
 *
 * 这个文件**刻意不 import 任何东西**：它要被浏览器、Node 测试、以及未来的
 * 重定向工具共同使用，保持零依赖最省事。
 */

/**
 * 单个关键点。
 *
 * ★ 所有分量都可以是 null —— **缺失时写 null，不伪造成 0**。
 * 原因：0 是一个合法坐标（画面正中间 / 深度 0），把它当"缺失"会让
 * 「这个人到底在不在画面里」变得无法判断，也会让置信度检查失效。
 * 上层必须显式处理 null，而不是不小心把它当成有效数据。
 */
export interface Landmark {
  x: number | null;
  y: number | null;
  z: number | null;
  visibility: number | null;
}

/** 一次 Holistic 推理的原始结果。 */
export interface MocapRawFrame {
  /** 采集时刻，毫秒。用 performance.now() 口径，保证与录制起点同一时间轴 */
  timestampMs: number;
  /** 归一化 [0,1] 的 33 点身体关键点（MediaPipe 口径） */
  poseLandmarks: Landmark[] | null;
  /** 世界坐标（米，原点在髋中心）的 33 点。★ Kalidokit 的 lm3d 必须用这个 */
  poseWorldLandmarks: Landmark[] | null;
  leftHandLandmarks: Landmark[] | null;
  rightHandLandmarks: Landmark[] | null;
  /** 468 点面部网格 */
  faceLandmarks: Landmark[] | null;
}

/** 采集来源信息。 */
export interface MocapCaptureSource {
  kind: 'camera';
  width: number;
  height: number;
  /** 预览画面是否镜像给人看 */
  previewMirrored: true;
  /** 送进模型的关键点是否经过镜像。★ 必须为 false，否则左右关系会被镜像两次 */
  modelInputMirrored: false;
  deviceLabel: string | null;
}

/** 采集质量统计。 */
export interface MocapQuality {
  /** 有效帧占比（0–1） */
  validFrameRatio: number;
  /** 推理帧率均值 */
  inferenceFpsMean: number;
  /** 最长连续跟踪丢失时长（毫秒） */
  longestTrackingGapMs: number;
  /** 人可读的警告，例如"存在超过 500ms 的丢失段" */
  warnings: string[];
}

/** 校准结果。 */
export interface MocapCalibration {
  /** 实际采集时长（毫秒） */
  durationMs: number;
  /** 校准期间身体检测率（0–1），门槛 0.8 */
  validFrameRatio: number;
  /** 中立姿态的规范化四元数（每个目标骨骼一个） */
  neutralPose: Record<string, [number, number, number, number]>;
  /** 修正量：Qcorrection = Qbase × inverse(Qneutral) */
  corrections: Record<string, [number, number, number, number]>;
}

/**
 * 一段原始采集（MocapCaptureV1）。
 *
 * 与 ClipFile v1 的关系：**clip 是成品，capture 是可回炉的原料。**
 * 分开存的原因：以后要重新调滤波参数或重做重定向时，只有 capture 里的原始关键点
 * 还能重算，clip 里的四元数已经丢失了推导过程。
 * capture 体积大（10 秒可能 5–10 MB），放 data/mocap/，不进 git。
 */
export interface MocapCaptureV1 {
  schemaVersion: 1;
  id: string;
  /** ISO 8601 */
  createdAt: string;
  durationMs: number;
  source: MocapCaptureSource;
  model: {
    name: 'mediapipe-holistic';
    version: string;
    options: Record<string, unknown>;
  };
  solver: {
    name: 'kalidokit';
    version: string;
    /** 重定向档位名，对应 retarget-profile.ts 里的 profile 标识 */
    profile: string;
  };
  calibration: MocapCalibration;
  quality: MocapQuality;
  frames: MocapRawFrame[];
}

/** 录制过程中的实时统计（页面 HUD 用）。 */
export interface RecordingStats {
  frameCount: number;
  durationMs: number;
  inferenceFps: number;
  validFrameRatio: number;
  longestTrackingGapMs: number;
  lostBoneCount: number;
}

// ── 常量：G2 的边界 ──────────────────────────────────────────────────────
export const MOCAP_LIMITS = {
  /** 单段录制最长 10 秒，到点自动停 */
  maxRecordingMs: 10_000,
  /** 裁剪最短区间 0.5 秒 */
  minTrimMs: 500,
  /** 录制有效帧不足 70% 时禁止生成 clip */
  minValidFrameRatio: 0.7,
  /** 超过这个时长算"跟踪丢失段" */
  lostGapMs: 500,
  /** 低置信度维持上一有效姿态的上限 */
  holdMs: 200,
  /** 200–500ms 之间向基础姿态渐变 */
  blendMs: 500,
  /** 实时姿态指数平滑时间常数 */
  smoothingTauMs: 80,
  /** 校准采集时长 */
  calibrationMs: 1_500,
  /** 校准要求的最低身体检测率 */
  calibrationMinDetectionRate: 0.8,
} as const;

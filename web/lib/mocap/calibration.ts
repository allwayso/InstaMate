/**
 * 中立姿态校准。
 *
 * 要解决的问题：Kalidokit 的零点是它自己的「参考姿态」语义，跟我们的
 * `BASE_STANDING_POSE`（双臂自然下垂的站姿）**不是同一个东西**。
 * 直接把它吐出来的数写进骨骼，角色会以奇怪的初始姿态开始动作。
 *
 * 做法（与计划 §5.3 一致）：
 *   1. 让人保持自然站姿 1.5 秒
 *   2. 这段时间里算出每根骨骼的「规范化姿态」Qcanonical，统一符号后平均 → Qneutral
 *   3. 算出每根骨骼的修正量：Qcorrection = Qbase × inverse(Qneutral)
 *   4. 之后每一帧：Qtarget = Qcorrection × Qcanonical
 *
 * 恒等式（有测试锁住）：当 Qcanonical == Qneutral 时，
 *     Qtarget = Qbase × inverse(Qneutral) × Qneutral = Qbase
 * 也就是「人保持中立姿态 → 角色回到基础站姿」。
 *
 * 本文件只做数学与采样窗口判定，不碰相机、不碰 VRM。
 */
import { baseQuatOf, mulQ, normalizeQ } from '../pose.ts';
import type { Pose, Quat } from '../pose.ts';
import { MOCAP_LIMITS } from './mocap-types.ts';
import { CALIBRATED_BONES, RETARGET_TARGET_BONES } from './retarget-profile.ts';
import type { RetargetBone } from './retarget-profile.ts';

/** 单位四元数的逆（共轭）。只对已规范化的四元数成立。 */
export function quatInverse(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * 四元数平均。
 *
 * ★ 关键点：**必须先统一符号**。四元数是双覆盖的 —— q 与 −q 表示同一个旋转，
 * 但直接逐分量取平均时，一个被写成 −q 的样本会把平均值拉向完全错误的方向
 * （极端情况下平均结果范数接近 0，归一化后方向随机）。
 *
 * 这里用两轮：先以首样本为参考对齐取平均，再用第一次的平均值当参考重算一遍。
 * 第二轮是为了容忍首样本恰好是个离群值的情况。
 */
export function averageQuats(qs: readonly Quat[]): Quat | null {
  if (qs.length === 0) return null;
  if (qs.length === 1) return normalizeQ(qs[0]);

  const alignAndMean = (ref: Quat): Quat => {
    const sum: Quat = [0, 0, 0, 0];
    for (const q of qs) {
      const s = dot(q, ref) < 0 ? -1 : 1;
      sum[0] += s * q[0];
      sum[1] += s * q[1];
      sum[2] += s * q[2];
      sum[3] += s * q[3];
    }
    return normalizeQ(sum);
  };

  const first = alignAndMean(qs[0]);
  const second = alignAndMean(first);
  // 两轮结果应当几乎一致；若差异很大说明样本本身离散（比如校准期间人动了），
  // 此时取第一轮结果更保守，离散度由上层用 validFrameRatio 与置信度去拦。
  return dot(first, second) < 0 ? first : second;
}

/**
 * 按每根骨骼把一组样本平均成一个「中立规范化姿态」。
 *
 * ★ 只用 CALIBRATED_BONES（10 根），**不含手指**：
 *   手指的"中立"就是伸直，源与目标本来就一致；给 30 根手指各算一个修正量
 *   只会多出 30 个出错的地方，而且"标定时手指蜷着"会立刻污染结果。
 */
export function averagePose(samples: readonly Pose[]): Pose {
  const out: Pose = {};
  for (const bone of CALIBRATED_BONES) {
    const qs = samples.map((s) => s[bone]).filter((q): q is Quat => Array.isArray(q) && q.length === 4);
    const avg = averageQuats(qs);
    if (avg) out[bone] = avg;
  }
  return out;
}

/**
 * 计算修正量：Qcorrection = Qbase × inverse(Qneutral)
 *
 * 注意合成顺序：`mulQ(Qbase, Qinv)` = 先应用 Qinv、再应用 Qbase。
 * 与 `Qtarget = Qcorrection × Qcanonical` 配合，得到
 *     Qtarget = Qbase × Qneutral⁻¹ × Qcanonical
 * 在 Qcanonical == Qneutral 时精确等于 Qbase。
 */
export function computeCorrections(neutral: Pose, basePose?: Pose): Pose {
  const out: Pose = {};
  for (const bone of CALIBRATED_BONES) {
    const qn = neutral[bone];
    if (!qn) continue;
    const qb = basePose?.[bone] ?? baseQuatOf(bone);
    out[bone] = normalizeQ(mulQ(qb, quatInverse(qn)));
  }
  return out;
}

/**
 * 把校准用到一帧姿态上：Qtarget = Qcorrection × Qcanonical。
 * 没有对应修正量的骨骼原样返回（不静默改成 identity —— 那会让角色突然弹回 T-pose）。
 */
export function applyCalibration(canonical: Pose, corrections: Pose): Pose {
  const out: Pose = {};
  for (const [bone, q] of Object.entries(canonical)) {
    const corr = corrections[bone];
    out[bone] = corr ? normalizeQ(mulQ(corr, q)) : q;
  }
  return out;
}

// ── 校准采样窗口 ─────────────────────────────────────────────────────────

/** 校准期间必须置信达标的关键骨骼（双肩、双肘、双腕对应的轨道） */
export const CALIBRATION_REQUIRED_BONES: readonly RetargetBone[] = [
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
];

/** 关键骨骼的置信度门槛 */
export const CALIBRATION_MIN_BONE_CONFIDENCE = 0.5;

/**
 * ★ 修正量大小的**实测参考区间**（度）—— 注意：**它不是门槛**。
 *
 * 这里记着一段走错路的历史，因为"看起来很有道理"的判据已经把校准弄坏过一次。
 *
 * 【当初为什么加门槛】标定时手臂抬起来过，导致 `Qneutral` 记的是"抬手姿态"，
 * 于是 `Qcorrection = Qbase × Qneutral⁻¹` 把整段偏移算错，表现为"肘反了""举不过
 * 头顶""转头反了"这类互相矛盾的现象。当时的想法是：**姿势正确时修正量应当很小**，
 * 所以设了 40° 的容差。
 *
 * 【那个前提是错的】"姿势正确 → 修正量小"只对上臂的 **z 分量**成立
 * （Kalidokit 静息 ∓1.25 rad vs 我们 ±72°，差 0.38°）。但 `ARM_AXES` 把上臂的
 * x、y 也映射进来了，而 `rigArm()` 对它们做了非线性变形（乘 PI、减下臂分量、clamp），
 * 它们的零点并不在"手臂下垂"。于是**合成四元数的模长接近、轴却完全不同**，
 * 差值被放大到几十度。
 *
 * 【实测：这条判据没有任何分辨力】用真实录制里的手臂比例合成关键点，
 * 扫描手臂下垂角 0°（水平/T-pose）→ 90°（竖直下垂），跑完整
 * Kalidokit → retarget → computeCorrections：
 *
 *     下垂角    0°    15°    30°    45°    60°    75°    90°
 *     修正量  77.4°  63.3°  51.1°  43.7°  44.4°  52.9°  88.1°
 *
 * **所有角度都超过 40°**，包括正确的那个（90°，88.1°）和错误的那个（0°，77.4°）。
 * 而当初"抬手标定"那次是 54.8° —— 正好落在正常范围中间。
 * 也就是说：这条门槛拦不住它想拦的东西，却会拒绝每一次正确校准。
 *
 * 【后果】它是一次回归：加入前（2026-09-22 21:00 之前）两次真人录制都校准成功；
 * 加入后校准永远失败，而提示语还在怪用户"姿势不对"。
 *
 * 【现在的做法】只测量、不设门槛 —— 数值作为信息展示（见 CalibrationOutcome），
 * 让人自己判断。真要自动判别"标定时手抬着"，得换一个有分辨力的信号
 * （例如 Kalidokit 上臂 z 的原始值：T-pose ≈ 0、自然下垂 ≈ −1.15~−1.25），
 * 而不是拿合成后的修正量当代理指标。
 */
export const CALIBRATION_CORRECTION_OBSERVED_DEG = { min: 43, max: 89 } as const;

const CORRECTION_CHECKED_BONES = [
  'rightUpperArm',
  'leftUpperArm',
  'rightLowerArm',
  'leftLowerArm',
  'head',
] as const;

/** 四元数旋转角（度）。取 |w| 是为了把 q 与 −q 看成同一个旋转。 */
function quatAngleDeg(q: Quat): number {
  return (2 * Math.acos(Math.min(1, Math.abs(q[3])))) / (Math.PI / 180);
}

export interface CalibrationFrame {
  timestampMs: number;
  /** 该帧是否检到身体（pose + world landmarks 都在，且有足够的可见点） */
  tracked: boolean;
  /** 每根目标骨骼的置信度 0–1（由 smoothing.ts 的 computeBoneConfidence 算出） */
  confidence: Record<string, number>;
  /** 该帧的规范化姿态 */
  canonical: Pose;
}

export interface CalibrationOutcome {
  ok: boolean;
  /** 人可读的失败原因；ok 为 true 时为空 */
  issues: string[];
  detectionRate: number;
  /** 通过全部检查、真正参与平均的帧数 */
  acceptedFrames: number;
  totalFrames: number;
  durationMs: number;
  /**
   * 修正量的最大旋转角（度）。**仅供展示**，不参与通过判定 ——
   * 正常自然站姿下它本来就在 43–89°，见 CALIBRATION_CORRECTION_OBSERVED_DEG。
   */
  maxCorrectionDeg: number;
  /** 修正量最大的骨骼名 */
  worstBone: string;
  neutralPose: Pose;
  corrections: Pose;
}

export interface CalibrationOptions {
  durationMs?: number;
  minDetectionRate?: number;
  minBoneConfidence?: number;
}

/**
 * 校准采样窗口。
 *
 * 故意做成「喂帧进来、自己判断够不够」的对象，而不是自己读时钟：
 * 这样单元测试可以喂合成帧序列，不需要计时器，也不需要摄像头。
 */
export class CalibrationSession {
  readonly durationMs: number;
  readonly minDetectionRate: number;
  readonly minBoneConfidence: number;

  private frames: CalibrationFrame[] = [];
  private startedAt: number | null = null;

  constructor(opts: CalibrationOptions = {}) {
    this.durationMs = opts.durationMs ?? MOCAP_LIMITS.calibrationMs;
    this.minDetectionRate = opts.minDetectionRate ?? MOCAP_LIMITS.calibrationMinDetectionRate;
    this.minBoneConfidence = opts.minBoneConfidence ?? CALIBRATION_MIN_BONE_CONFIDENCE;
  }

  start(nowMs: number): void {
    this.frames = [];
    this.startedAt = nowMs;
  }

  add(frame: CalibrationFrame): void {
    this.frames.push(frame);
  }

  get totalFrames(): number {
    return this.frames.length;
  }

  get elapsedMs(): number {
    if (this.startedAt === null || this.frames.length === 0) return 0;
    return this.frames[this.frames.length - 1].timestampMs - this.startedAt;
  }

  get detectionRate(): number {
    if (this.frames.length === 0) return 0;
    return this.frames.filter((f) => f.tracked).length / this.frames.length;
  }

  /** 时长够了就算采集完成 —— 是否**可用**由 finish() 判定 */
  get isDone(): boolean {
    return this.elapsedMs >= this.durationMs;
  }

  get progress(): number {
    return Math.min(1, this.elapsedMs / this.durationMs);
  }

  private boneConfidenceOk(frame: CalibrationFrame): boolean {
    return CALIBRATION_REQUIRED_BONES.every(
      (b) => (frame.confidence[b] ?? 0) >= this.minBoneConfidence,
    );
  }

  finish(): CalibrationOutcome {
    const issues: string[] = [];
    const durationMs = this.elapsedMs;
    const detectionRate = this.detectionRate;

    if (this.frames.length === 0) {
      issues.push('校准期间没有收到任何帧');
    }
    if (durationMs < this.durationMs) {
      issues.push(`校准时长不足：${Math.round(durationMs)}ms < ${this.durationMs}ms`);
    }
    if (detectionRate < this.minDetectionRate) {
      issues.push(
        `身体检测率 ${(detectionRate * 100).toFixed(1)}% 低于门槛 ${(this.minDetectionRate * 100).toFixed(0)}%`,
      );
    }

    const accepted = this.frames.filter((f) => f.tracked && this.boneConfidenceOk(f));
    const lowConfFrames = this.frames.filter((f) => f.tracked && !this.boneConfidenceOk(f)).length;
    if (lowConfFrames > 0) {
      issues.push(
        `${lowConfFrames} 帧的肩/肘/腕置信度不足 ${this.minBoneConfidence}，已排除出平均`,
      );
    }
    if (accepted.length < 2) {
      issues.push(`可用帧只有 ${accepted.length} 帧，不足以求平均`);
    }

    const neutralPose = accepted.length ? averagePose(accepted.map((f) => f.canonical)) : {};
    const missingBones = CALIBRATED_BONES.filter((b) => !neutralPose[b]);
    if (accepted.length && missingBones.length) {
      issues.push(`以下骨骼没有可用的中立样本：${missingBones.join(', ')}`);
    }

    const corrections = accepted.length ? computeCorrections(neutralPose) : {};

    // 只测量、不判定。上限见 CALIBRATION_CORRECTION_OBSERVED_DEG 的说明 ——
    // 「修正量大 = 姿势不对」这个前提不成立，所以这里**刻意不加 issues**。
    let maxCorrectionDeg = 0;
    let worstBone = '';
    for (const b of CORRECTION_CHECKED_BONES) {
      const c = corrections[b];
      if (!c) continue;
      const deg = quatAngleDeg(c);
      if (deg > maxCorrectionDeg) {
        maxCorrectionDeg = deg;
        worstBone = b;
      }
    }

    const ok = issues.length === 0;
    return {
      ok,
      issues,
      detectionRate,
      acceptedFrames: accepted.length,
      totalFrames: this.frames.length,
      durationMs,
      maxCorrectionDeg,
      worstBone,
      neutralPose: ok ? neutralPose : {},
      corrections: ok ? corrections : {},
    };
  }
}

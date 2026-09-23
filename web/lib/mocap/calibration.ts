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
 * 修正量的容差（度）。
 *
 * ★ 这条是为了拦住一个很隐蔽、但破坏力极大的错误：**标定时姿势不对**。
 *
 * 实测踩过：标定时手臂是抬起来的，于是 Qneutral 记的是"抬手姿态"，
 * 而 Qcorrection = Qbase × inverse(Qneutral) 把它映射成基础站姿 ——
 * 结果是**整段偏移被算错**，表现为
 *   · 肘部零点被平移 → 看起来像"肘反了"
 *   · 抬臂的可用范围被偏移吃掉 → "举不过头顶"
 *   · 转头方向也不对
 * 而且这些症状互相矛盾，极难从渲染结果反推原因。
 *
 * 关键线索是：**不加校准反而是对的** —— 说明映射本身没问题，是校准量错了。
 *
 * 为什么能用"修正量大小"当判据：Kalidokit 的静息值与我们的静息值本来就接近
 * （上臂 ∓1.25 rad vs ±72°，差 0.38°；前臂 0 vs 8° 的自然屈肘），
 * 所以**姿势正确时修正量应当很小**。修正量一大，就说明标定姿势偏离了自然站姿。
 */
export const CALIBRATION_MAX_CORRECTION_DEG = 40;

/**
 * 参与容差检查的骨骼。
 *
 * 容差取 40°：足以拦住"抬着手标定"（实测抬手 55° → 修正量 54.8°），
 * 又不会对"Kalidokit 的头部零点本来就不在正前方"这类正常差异过敏。
 * 参考值（实测）：自然站姿下上臂 0.38°、前臂 8.00°（我们的自然屈肘）。
 */
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
  /** 修正量的最大旋转角（度）。姿势正确时应当很小（上臂约 0.4°） */
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

    // ★ 校准可信度自检：修正量过大说明标定姿势不是自然站姿
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
    if (accepted.length && maxCorrectionDeg > CALIBRATION_MAX_CORRECTION_DEG) {
      issues.push(
        `校准姿态偏离自然站姿过多（${worstBone} 的修正量 ${maxCorrectionDeg.toFixed(1)}°，` +
          `容差 ${CALIBRATION_MAX_CORRECTION_DEG}°）。` +
          `校准时应**双臂自然下垂、目视前方**，不要举手或转头 ——` +
          `标定姿势不对会让整段偏移算错，表现为"肘反了""举不过头顶""转头反了"这类互相矛盾的现象。`,
      );
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

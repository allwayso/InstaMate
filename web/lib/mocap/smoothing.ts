/**
 * 置信度评估、四元数指数平滑、以及低置信度三级回退。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ★ 反直觉但必须照做的事：置信度要跟着 Kalidokit 的索引走
 * ══════════════════════════════════════════════════════════════════════════
 *  从 kalidokit@1.1.5 的 `PoseSolver/calcArms.js` 源码（不是文档）可以读出：
 *
 *      const UpperArm = {
 *        r: Vector.findRotation(lm[11], lm[13]),   // ← 11/13
 *        l: Vector.findRotation(lm[12], lm[14]),
 *      };
 *      const Hand = { r: ...lm[15], lm[17], lm[19] ... };
 *  而离屏守卫里：`rightHand` 用 `lm3d[15]`、`leftHand` 用 `lm3d[16]`。
 *
 *  MediaPipe 的 11/13/15/17/19 是 **left_**shoulder/elbow/wrist/pinky/index。
 *  也就是说 **Kalidokit 的 `Right*` 读的是 MediaPipe 的 `left_*` 那一组**。
 *
 *  所以：判断「右臂数据可不可信」必须去看 MediaPipe 的左侧点。
 *  否则一旦打开左右交换，置信度会评估另一条手臂 —— 手势对了但图像抖的时候，
 *  会出现「正确的那条手臂因为另一条被遮挡而停止更新」这种极难查的 bug。
 *
 *  下面用 KALIDOKIT_SOURCE_POINTS 显式固化这个对应关系。
 */
import { slerp } from '../pose.ts';
import type { Pose, Quat } from '../pose.ts';
import { MOCAP_LIMITS, type Landmark, type MocapRawFrame } from './mocap-types.ts';
import { resolveRules } from './retarget-profile.ts';
import { isHandUsable } from './kalidokit-solver.ts';
import type { RetargetBone } from './retarget-profile.ts';

/** MediaPipe Pose 关键点索引（33 点口径） */
const MP = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
} as const;

/**
 * Kalidokit 各来源键实际读取的 MediaPipe 索引。
 * 这些数字全部来自 kalidokit 源码，不是推测（见文件头）。
 */
export const KALIDOKIT_SOURCE_POINTS: Record<string, readonly number[]> = {
  RightUpperArm: [MP.leftShoulder, MP.leftElbow],
  RightLowerArm: [MP.leftElbow, MP.leftWrist],
  RightHand: [MP.leftWrist],
  LeftUpperArm: [MP.rightShoulder, MP.rightElbow],
  LeftLowerArm: [MP.rightElbow, MP.rightWrist],
  LeftHand: [MP.rightWrist],
  Spine: [MP.leftShoulder, MP.rightShoulder, MP.leftHip, MP.rightHip],
};

/**
 * 手部来源键 → 用哪一侧的手部关键点。
 *
 * ★ 手部关键点**没有 visibility 字段**（实测：整段录制里 21 个点的 visibility 全是 null）。
 *   所以手部的置信度只能是"全有 / 全无"：21 个点都在且坐标有限 → 1，否则 0。
 *   这也意味着手部会整只地出现/消失，而不是逐点退化 ——
 *   抖动由平滑器的三级回退兜住，不要在置信度上再叠一层假的连续量。
 */
/**
 * 仍然由 `Pose.solve` 输出的两个旧 Hand 键（腕部已改走 HandSolver，但枚举里还留着）。
 * 它们借助身体点 15/17/19 估掌朝向，仍可作为腕部的兜底置信来源。
 */
const HAND_SOURCES: Record<string, 'leftHandLandmarks' | 'rightHandLandmarks'> = {
  // Kalidokit 的 RightHand 读 lm[15]/[17]/[19] = MediaPipe 左手
  RightHand: 'leftHandLandmarks',
  LeftHand: 'rightHandLandmarks',
};

/** 取一个关键点的可见度；缺失一律记 0（而不是把 null 当 0 坐标） */
function vis(lm: Landmark | undefined | null): number {
  if (!lm) return 0;
  const v = lm.visibility;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    // 没有 visibility 字段时：只要坐标齐全就当作可用，但不能给满分
    const ok = typeof lm.x === 'number' && typeof lm.y === 'number';
    return ok ? 0.6 : 0;
  }
  return Math.max(0, Math.min(1, v));
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 面部关键点是否完整：够不够点、以及可见度够不够 */
export function faceConfidence(frame: MocapRawFrame): number {
  const f = frame.faceLandmarks;
  if (!f || f.length === 0) return 0;
  // 468 点是完整网格；明显少点说明检测不完整
  const completeness = Math.min(1, f.length / 468);
  // 采样一部分点算平均可见度即可（全量 468 点没必要）
  const sample = [];
  for (let i = 0; i < f.length; i += 12) sample.push(vis(f[i]));
  const v = mean(sample);
  return Math.max(0, Math.min(1, v * completeness));
}

/** 身体（pose + world）是否算检到 */
export function isBodyTracked(frame: MocapRawFrame): boolean {
  const p = frame.poseLandmarks;
  const w = frame.poseWorldLandmarks;
  if (!p || !w || p.length < 25 || w.length < 25) return false;
  // 至少双脚之外的躯干要可见：肩、肘、腕、髋
  const key = [MP.leftShoulder, MP.rightShoulder, MP.leftElbow, MP.rightElbow, MP.leftWrist, MP.rightWrist];
  return key.every((i) => vis(p[i]) > 0);
}

/**
 * 按 **Kalidokit 的来源键** 计算置信度。
 * 用来源键而不是目标骨骼名，是为了让左右交换之后仍然评估同一条手臂。
 */
export function computeSourceConfidence(frame: MocapRawFrame): Record<string, number> {
  const out: Record<string, number> = {};
  const pose = frame.poseLandmarks;

  for (const [source, idxs] of Object.entries(KALIDOKIT_SOURCE_POINTS)) {
    if (!pose) {
      out[source] = 0;
      continue;
    }
    let c = Math.min(...idxs.map((i) => vis(pose[i])));
    const handKey = HAND_SOURCES[source];
    if (handKey) {
      const hand = frame[handKey];
      if (!hand || hand.length === 0) {
        c = Math.min(c, 0.6); // 手部点整体缺失：腕点还能用，但掌朝向不可信
      } else {
        // isHandUsable 是布尔值，显式转 1/0 —— 直接参与算术 TS 会拦（也是好事）
        c = Math.min(1, Math.max(0, c * 0.5 + (isHandUsable(hand) ? 1 : 0) * 0.5));
      }
    }
    out[source] = Math.max(0, Math.min(1, c));
  }

  out['Face.head'] = faceConfidence(frame);

  // ── 手部来源（HandSolver 的关节键）──────────────────────────────────
  // 全有 / 全无，理由见 HAND_SOURCE_PREFIX 上方
  for (const [side, key] of [
    ['Right', 'leftHandLandmarks'],
    ['Left', 'rightHandLandmarks'],
  ] as const) {
    const hand = frame[key];
    const c = isHandUsable(hand) ? 1 : 0;
    out[`${side}Wrist`] = c;
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
        out[`${side}${f}${seg}`] = c;
      }
    }
  }
  // Kalidokit 的 Pose 输出里那两个 Hand 键（现在不再驱动腕部，但保留以免别处引用出错）
  out['RightHand'] = out['RightWrist'] ?? 0;
  out['LeftHand'] = out['LeftWrist'] ?? 0;

  return out;
}

/** 把来源键置信度映射到目标骨骼（跟随 retarget 的左右解析） */
export function computeBoneConfidence(
  frame: MocapRawFrame,
  swap: boolean = false,
): Record<string, number> {
  const sources = computeSourceConfidence(frame);
  const rules = resolveRules(swap);
  const out: Record<string, number> = {};
  for (const [bone, rule] of Object.entries(rules)) out[bone] = sources[rule.from] ?? 0;
  return out;
}

// ── 平滑与回退 ───────────────────────────────────────────────────────────

export type ConfidenceTier = 'tracked' | 'hold' | 'blend' | 'lost';

export interface SmoothedFrame {
  /** 可直接写进 CharacterRuntime 的姿态（已平滑、已回退处理） */
  pose: Pose;
  /** 本帧处于「跟踪丢失」的骨骼（>500ms） */
  lost: RetargetBone[];
  tiers: Record<string, ConfidenceTier>;
}

export interface SmootherOptions {
  tauMs?: number;
  holdMs?: number;
  blendMs?: number;
  /** 低于这个置信度就算"这一帧这根骨骼不可信" */
  minConfidence?: number;
  /** 回退目标姿态 */
  basePose: Pose;
}

/** 每根骨骼的私人状态 */
interface BoneState {
  smoothed: Quat;
  lastValid: Quat;
  lowSince: number | null;
  tier: ConfidenceTier;
}

/**
 * 四元数指数平滑 + 低置信度三级回退。
 *
 * 三级规则（计划 §5.4）：
 *   · 低置信度 ≤200ms          → 保持上一有效姿态
 *   · 200–500ms               → 向基础姿态渐变
 *   · >500ms                  → 标记该段跟踪丢失
 *
 * 平滑用指数形式 `alpha = 1 - exp(-dt/tau)`：好处是**与帧率无关**，
 * 掉帧或换刷新率不会改变手感（和 G1 播放器"按秒采样"是同一个理由）。
 */
export class PoseSmoother {
  readonly tauMs: number;
  readonly holdMs: number;
  readonly blendMs: number;
  readonly minConfidence: number;
  readonly basePose: Pose;

  private state = new Map<string, BoneState>();
  /** 要平滑的骨骼集合 = 基础姿态的键 ∪ 至今见过的 canonical 键 */
  private bones: Set<string>;

  constructor(opts: SmootherOptions) {
    this.tauMs = opts.tauMs ?? MOCAP_LIMITS.smoothingTauMs;
    this.holdMs = opts.holdMs ?? MOCAP_LIMITS.holdMs;
    this.blendMs = opts.blendMs ?? MOCAP_LIMITS.blendMs;
    this.minConfidence = opts.minConfidence ?? 0.5;
    this.basePose = opts.basePose;
    this.bones = new Set(Object.keys(opts.basePose));
  }

  /** 硬复位到基础姿态。切角色、重新校准、开始新录制时调用。 */
  reset(): void {
    this.state.clear();
    this.bones = new Set(Object.keys(this.basePose));
  }

  /**
   * 登记本帧出现的骨骼。
   *
   * ★ 这一步不能省。`BASE_STANDING_POSE` 只有 4 根骨骼（两条上臂 + 两条前臂），
   * 而重定向产出 10 根（还有 spine/chest/neck/head 与两只手）。
   * 若只按基础姿态的键去平滑，那 6 根会被**静默丢弃**：角色能抬胳膊、
   * 但脊柱与头完全不动，而且不报错，极难定位。
   * （这个是写测试时发现的，不是推理出来的。）
   */
  private registerBones(canonical: Pose | null): void {
    if (!canonical) return;
    for (const b of Object.keys(canonical)) this.bones.add(b);
  }

  /** 当前参与平滑的骨骼（供页面显示与断言，避免“看起来动了其实少了一半”） */
  getBoneNames(): string[] {
    return [...this.bones];
  }

  private stateOf(bone: string): BoneState {
    let s = this.state.get(bone);
    if (!s) {
      const base: Quat = (this.basePose[bone] ?? [0, 0, 0, 1]) as Quat;
      s = { smoothed: [...base], lastValid: [...base], lowSince: null, tier: 'tracked' };
      this.state.set(bone, s);
    }
    return s;
  }

  /**
   * 推进一步。
   *
   * @param canonical 本帧的规范化姿态（已校准）。整帧收不到就传 null
   * @param confidence 每根骨骼的置信度
   * @param nowMs 当前时刻（毫秒）—— 显式传入而不是读时钟，便于测试
   * @param dtMs 距上一帧的毫秒数
   */
  update(
    canonical: Pose | null,
    confidence: Record<string, number>,
    nowMs: number,
    dtMs: number,
  ): SmoothedFrame {
    this.registerBones(canonical);
    const bones = [...this.bones];
    const pose: Pose = {};
    const lost: RetargetBone[] = [];
    const tiers: Record<string, ConfidenceTier> = {};

    // 指数平滑系数：与帧率无关
    const alpha = dtMs <= 0 ? 1 : 1 - Math.exp(-dtMs / this.tauMs);

    for (const bone of bones) {
      const s = this.stateOf(bone);
      const sample = canonical?.[bone];
      const conf = confidence[bone] ?? 0;
      const valid = !!sample && conf >= this.minConfidence;

      if (valid && sample) {
        s.lastValid = [...sample];
        s.lowSince = null;
        s.tier = 'tracked';
      } else {
        if (s.lowSince === null) s.lowSince = nowMs;
        const gap = nowMs - s.lowSince;

        if (gap <= this.holdMs) {
          s.tier = 'hold';
        } else if (gap <= this.blendMs) {
          s.tier = 'blend';
        } else {
          s.tier = 'lost';
          lost.push(bone as RetargetBone);
        }
      }

      // 目标值：有效帧用样本；否则按档位取「上一有效」或「向基础姿态渐变」
      let target: Quat;
      if (valid && sample) {
        target = sample;
      } else if (s.tier === 'hold') {
        target = s.lastValid;
      } else {
        const base = (this.basePose[bone] ?? [0, 0, 0, 1]) as Quat;
        if (s.tier === 'blend') {
          const gap = nowMs - (s.lowSince ?? nowMs);
          const t = (gap - this.holdMs) / Math.max(1, this.blendMs - this.holdMs);
          target = slerp(s.lastValid, base, Math.max(0, Math.min(1, t)));
        } else {
          target = base;
        }
      }

      s.smoothed = slerp(s.smoothed, target, alpha);
      pose[bone] = [...s.smoothed] as Quat;
      tiers[bone] = s.tier;
    }

    return { pose, lost, tiers };
  }

  /** 当前处于丢失态的骨骼（不推进时间，只读） */
  getLostBones(): RetargetBone[] {
    const out: RetargetBone[] = [];
    for (const [bone, s] of this.state) if (s.tier === 'lost') out.push(bone as RetargetBone);
    return out;
  }
}

/**
 * Kalidokit 输出 → VRM normalized 骨骼四元数的重定向档案。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么需要一个单独的档案
 * ══════════════════════════════════════════════════════════════════════════
 *  Kalidokit 吐出来的不是标准欧拉角，而是它自己调过的一套「rig 空间」。
 *  来自 `kalidokit@1.1.5/dist/PoseSolver/calcArms.js` 的 rigArm()：
 *
 *      const invert = side === RIGHT ? 1 : -1;
 *      UpperArm.z *= -2.3 * invert;
 *      UpperArm.y *= PI * invert;
 *      UpperArm.y -= Math.max(LowerArm.x);            // ← 非线性耦合项
 *      UpperArm.y -= -invert * Math.max(LowerArm.z, 0); // ← 又一个
 *      UpperArm.x -= 0.3 * invert;
 *      UpperArm.x = clamp(UpperArm.x, -0.5, PI);      // ← 还被 clamp 过
 *
 *  里面有左右反向、非线性耦合、clamp —— **不能靠推导得到对应关系，只能实测标定**。
 *  所以本文件的设计目标是：把「所有需要标定的东西」集中成几个常量，
 *  让 P3 的标定结果落进来时不用改任何逻辑代码。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ★ 当前状态：轴向映射【尚未实测】
 * ══════════════════════════════════════════════════════════════════════════
 *  下面的初始值是根据 G1 已实测的 rig 约定 + Kalidokit 源码做的**合理起点**，
 *  目的是让 P3 的标定变成「确认/微调」而不是盲搜。但它**不是结论**。
 *
 *  为此导出 `RETARGET_IS_MEASURED = false`：页面必须据此显示警告条，
 *  避免未验证的映射被当成已验证的结果用出去。P3 标定完成、写实测判据后改成 true。
 *
 *  P3 要填的两件事：
 *    1. `swapLeftRight` —— kalidokit 的 Right* 对应 MediaPipe 的 left_* 命名
 *       （源码实锤：calcArms 用 lm[11],lm[13] 算 r，而 11/13 是 left_shoulder/left_elbow），
 *       但物理左右必须真人抬右手来定。判据：抬右手 → 看哪个键在变。
 *    2. 每个骨骼的轴映射与符号 —— 分别抬臂/屈肘/转头，记录哪个分量在变、方向如何。
 *
 * ══════════════════════════════════════════════════════════════════════════
 */
import { mulQ, normalizeQ } from '../pose.ts';
import type { Pose, Quat } from '../pose.ts';

/** 档案标识，写进 capture 的 solver.profile */
export const RETARGET_PROFILE_ID = 'upper-body-v1';

/**
 * 是否已完成实测标定。
 * false 时页面必须显示「轴向映射未实测」警告 —— 这是刻意的：宁可吵闹，
 * 也不要让一个没验过的映射悄悄产出看起来正常的动作。
 */
export const RETARGET_IS_MEASURED = false;

/** G2 首版只生成这些骨骼的轨道（上半身 + 头）。腿、手指、根位移、表情都不进。 */
export const RETARGET_TARGET_BONES = [
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
] as const;

export type RetargetBone = (typeof RETARGET_TARGET_BONES)[number];

export type Axis = 'x' | 'y' | 'z';
export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** 一根目标轴取自来源的哪根轴、什么符号 */
export interface AxisSpec {
  axis: Axis;
  sign: 1 | -1;
}

/**
 * 目标欧拉三元组：[目标X, 目标Y, 目标Z] 各自的取法。
 * 允许重复取同一根来源轴（有些 rig 空间一个分量承载两种信息）。
 */
export type AxisTriple = readonly [AxisSpec, AxisSpec, AxisSpec];

/** 单根目标骨骼的重定向规则 */
export interface BoneRule {
  /** Kalidokit 输出里的键名 */
  from: string;
  /** 取多少。脊柱/头颈要拆成两段时用（0.35 / 0.65） */
  weight: number;
  /** 轴映射与符号 —— ★ P3 标定的主要落点 */
  axes: AxisTriple;
}

const ax = (axis: Axis, sign: 1 | -1 = 1): AxisSpec => ({ axis, sign });

/**
 * 左右成对的骨骼组。`swapLeftRight` 打开时，成对两侧的**来源键对调**，
 * 并且对「镜像奇性」的轴取反（见 MIRROR_ODD_AXES 的推导）。
 *
 * 只换来源键、符号不动是**错的** —— 实测反馈：会得到"左右对了但上下反了"。
 * 数值上很好验：
 *     Kalidokit 静息  K.RightUpperArm.z = −1.25   K.LeftUpperArm.z = +1.25
 *     我们的静息      rightUpperArm = +1.257     leftUpperArm = −1.257
 *   不交换（z × −1）：right ← K.Right → +1.25 ✅
 *   错误的交换（z × −1）：right ← K.Left → −1.25 ❌ 手臂被压下去
 *   正确的交换（z × +1）：right ← K.Left → +1.25 ✅
 */
const SIDED_PAIRS: readonly (readonly [RetargetBone, RetargetBone])[] = [
  ['rightUpperArm', 'leftUpperArm'],
  ['rightLowerArm', 'leftLowerArm'],
  ['rightHand', 'leftHand'],
];

/**
 * 镜像（矢状面反射）下**变号**的轴。
 *
 * 矢状面 = 人体左右对称那个平面，它的法线是 X（左右轴）。
 * 反射的规律：**旋转轴落在镜面内的变号，旋转轴与法线平行的不变号**。
 *     · Y（偏航/上下轴）落在镜面内 → 变号
 *     · Z（侧摆/前后轴）落在镜面内 → 变号
 *     · X（左右轴 = 镜面法线） → 不变号
 *
 * 所以交换左右时只取反 Y 与 Z，X 保持原样。
 */
export const MIRROR_ODD_AXES: readonly Axis[] = ['y', 'z'];

function mirrorAxes(triple: AxisTriple): AxisTriple {
  const flip = (s: AxisSpec): AxisSpec =>
    MIRROR_ODD_AXES.includes(s.axis) ? { axis: s.axis, sign: (s.sign === 1 ? -1 : 1) as 1 | -1 } : s;
  return [flip(triple[0]), flip(triple[1]), flip(triple[2])] as const;
}

/**
 * ★ 需标定的常量 ①：左右是否需要交换。
 *
 * 源码实锤（kalidokit@1.1.5）：`calcArms` 用 `lm[11],lm[13]` 算 `r`，
 * 而 MediaPipe 的 11/13 是 `left_shoulder`/`left_elbow`；离屏守卫里
 * `rightHand` 用的是 `lm[15]`（MediaPipe 的 `left_wrist`）。
 * 即 **Kalidokit 的 Right* = MediaPipe 的 left_* 命名**。
 *
 * 这与 MediaPipe 自己那条著名前提吻合：Hands/Holistic 的 handedness 输出
 * **假设输入图像是镜像的**，非镜像场景需自行交换。
 *
 * 但「命名相反」不等于「物理左右相反」—— 必须真人抬右手实测。
 * 判据：抬**右手** → 观察 `Pose.solve` 输出里 `RightUpperArm` 还是 `LeftUpperArm` 变了。
 *   · 若变的是 `LeftUpperArm` → 设为 true
 *   · 若变的是 `RightUpperArm` → 保持 false
 * 最终以 VRM 侧数值断言确认：抬右手时 `rightHand.x < 0` 侧抬高，且左手 Δ 精确为 0。
 */
export const swapLeftRight = true;

/**
 * ★ 实测记录（F3 已完成）
 *
 * 判据与结果：
 *   · 不交换（false）时，真人抬右手 → VRM 的**左**臂动 → 左右是反的
 *   · 打开交换后左右正确，但**上下也反了** → 说明只换来源键不够
 *
 * 后半句这个"上下反了"其实是一条很有用的线索：它证明符号也必须跟着换。
 * 数值上很清楚（Kalidokit 静息 K.RightUpperArm.z = −1.25，L = +1.25；
 * 我们静息 rightUpperArm = +72° ≈ +1.257，left = −1.257）：
 *
 *     不交换（z × −1）      : right ← K.Right → +1.25  ✅
 *     只换键、符号不动      : right ← K.Left  → −1.25  ❌ 差 143°，手臂被压下去
 *     换键 + 镜像奇性轴取反 : right ← K.Left  → +1.25  ✅
 *
 * 所以交换要做两件事：来源键对调 + 镜像奇性轴（Y、Z）取反。见 resolveRules 与
 * MIRROR_ODD_AXES。测试用"Kalidokit 静息必须映射到我们的静息"这条不变式钉住了它，
 * 两种配置下都验。
 *
 * 实测环境：2026-09-22，AMD Radeon 780M 本机，Insta360 / 内置摄像头，
 * Seed-san + compat.vrm 双角色，selfieMode: false（模型输入不镜像）。
 */
/**
 * ★ 需标定的常量 ②：每根骨骼的轴映射。
 *
 * 起点怎么来的（不是瞎猜，但也**不是实测**）：
 *  · G1 已实测我们的 rig 约定（见 pose.ts 的 RIG_AXIS_CONVENTION）：
 *      Z = 侧摆（抬臂/屈肘，右 −/左 +）、Y = 偏航（转头）、X = 前后摆/俯仰
 *  · Kalidokit 的 `UpperArm.z` 是姿态主导项：手臂自然下垂时
 *      `RightUpperArm.z = -1.25`、`LeftUpperArm.z = +1.25`（见其 RestingDefault），
 *    且 rigArm 里 z 的系数最大（−2.3），说明 z 承载「抬/垂」→ 对应我们的 Z。
 *  · 方向：Kalidokit 右臂 z 由 −1.25 往上抬是**变大**；我们的右臂由 +72° 往上抬是**变小**
 *    → 符号取负。左臂同理（Kalidokit 用 invert 把左侧也反过来了，故两侧同取负）。
 *  · `UpperArm.y` 被乘了 PI 又被下臂分量修正，是前后摆 → 猜测对应我们的 X，但**没把握**。
 *
 * → Z 轴这一条有依据，X/Y 两条是待验证的候选。P3 必须逐条实测替换。
 */
const ARM_AXES: AxisTriple = [ax('x', 1), ax('y', 1), ax('z', -1)];
const ARM_REST_WEIGHT = 1;

/**
 * 骨骼规则表。
 *
 * 脊柱拆两段（spine 35% / chest 65%）、头颈拆两段（neck 35% / head 65%）——
 * 这是计划定的比例：让弯曲分散到两段，避免单关节折断。
 * 肩（shoulder）**刻意不驱动**，保持 BASE_STANDING_POSE：
 * Kalidokit 没有稳定的肩骨输出，硬驱动会抖。
 */
export const RETARGET_RULES: Readonly<Record<RetargetBone, BoneRule>> = {
  spine: { from: 'Spine', weight: 0.35, axes: ARM_AXES },
  chest: { from: 'Spine', weight: 0.65, axes: ARM_AXES },
  neck: { from: 'Face.head', weight: 0.35, axes: ARM_AXES },
  head: { from: 'Face.head', weight: 0.65, axes: ARM_AXES },
  rightUpperArm: { from: 'RightUpperArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  rightLowerArm: { from: 'RightLowerArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  rightHand: { from: 'RightHand', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  leftUpperArm: { from: 'LeftUpperArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  leftLowerArm: { from: 'LeftLowerArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  leftHand: { from: 'LeftHand', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
};

// ── 欧拉 → 四元数 ────────────────────────────────────────────────────────

/**
 * 欧拉 XYZ → 四元数。
 *
 * ★ 必须与 **three.js 的 `Euler(x, y, z, 'XYZ')`** 完全一致，
 * 因为 Kalidokit 的设计前提就是「把这三个数直接赋给 three.js 的 rotation」。
 *
 * 约定已用实验钉死（three.js 0.186.0 实测）：
 *      Euler('XYZ') === Rx × Ry × Rz          （与 Rz×Ry×Rx 差 44.9°，不是它）
 * 参考值见 tests/mocap-retarget.test.mjs 的 EULER_XYZ_REFERENCE。
 *
 * 注意本函数的输入是**弧度**：Kalidokit 注释自称 "Returns Values in Radians"。
 */
export function eulerXYZToQuat(e: XYZ): Quat {
  const hx = e.x / 2;
  const hy = e.y / 2;
  const hz = e.z / 2;
  const sx = Math.sin(hx);
  const cx = Math.cos(hx);
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sz = Math.sin(hz);
  const cz = Math.cos(hz);
  // Rx = [sx,0,0,cx]  Ry = [0,sy,0,cy]  Rz = [0,0,sz,cz]
  const qx: Quat = [sx, 0, 0, cx];
  const qy: Quat = [0, sy, 0, cy];
  const qz: Quat = [0, 0, sz, cz];
  return normalizeQ(mulQ(mulQ(qx, qy), qz));
}

/** 按 AxisTriple 把来源欧拉三元组映射到目标欧拉三元组 */
export function mapEuler(src: XYZ, triple: AxisTriple): XYZ {
  const pick = (s: AxisSpec): number => src[s.axis] * s.sign;
  return { x: pick(triple[0]), y: pick(triple[1]), z: pick(triple[2]) };
}

// ── 左右交换 ─────────────────────────────────────────────────────────────

/** 把规则表按 swapLeftRight 解析成「目标骨骼 → 实际使用的规则」 */
export function resolveRules(swap: boolean = swapLeftRight): Record<RetargetBone, BoneRule> {
  const out = {} as Record<RetargetBone, BoneRule>;
  for (const bone of RETARGET_TARGET_BONES) out[bone] = RETARGET_RULES[bone];
  if (swap) {
    for (const [a, b] of SIDED_PAIRS) {
      const ra = out[a];
      const rb = out[b];
      // ★ 来源键对调 **且** 镜像奇性轴取反 —— 两件事必须一起做，
      //   只换来源键会得到「左右对了但上下反了」（实测反馈）。
      out[a] = { ...rb, axes: mirrorAxes(rb.axes) };
      out[b] = { ...ra, axes: mirrorAxes(ra.axes) };
    }
  }
  return out;
}

// ── 输入形状（结构化，不 import kalidokit）────────────────────────────────
//
// 刻意不 import kalidokit：一是 Node 侧加载不了它的 ESM 目录导入，
// 二是重定向逻辑不该跟求解器版本绑死。

export interface KalidokitPoseLike {
  RightUpperArm?: XYZ | null;
  RightLowerArm?: XYZ | null;
  RightHand?: XYZ | null;
  LeftUpperArm?: XYZ | null;
  LeftLowerArm?: XYZ | null;
  LeftHand?: XYZ | null;
  Spine?: XYZ | null;
  [key: string]: XYZ | null | undefined;
}

export interface KalidokitFaceLike {
  head?: XYZ | null;
  [key: string]: unknown;
}

export interface RetargetInput {
  pose: KalidokitPoseLike | null;
  face?: KalidokitFaceLike | null;
}

export interface RetargetOutput {
  /** 目标骨骼 → 绝对局部四元数（未叠加基础站姿，也未做校准） */
  pose: Pose;
  /** 来源缺失、没能算出来的骨骼 */
  missing: RetargetBone[];
}

/** 取来源值；支持 `Face.head` 这种带前缀的键 */
function lookupSource(from: string, input: RetargetInput): XYZ | null {
  if (from.startsWith('Face.')) {
    const key = from.slice('Face.'.length);
    const v = input.face?.[key];
    return isXYZ(v) ? v : null;
  }
  const v = input.pose?.[from];
  return isXYZ(v) ? v : null;
}

function isXYZ(v: unknown): v is XYZ {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}

/**
 * 求一个采集帧对应的 10 根目标骨骼的「规范化姿态」（canonical pose）。
 *
 * 这一步**只做**名字映射、轴映射、权重缩放、欧拉→四元数。
 * 不做：校准偏移（calibration.ts）、平滑与置信度回退（smoothing.ts）、
 * 基础站姿叠加（pose.ts 的 poseWith / clip-player 的 withBasePose）。
 * 保持单一职责，这样每一步都能单独测。
 */
export function retarget(input: RetargetInput, swap: boolean = swapLeftRight): RetargetOutput {
  const rules = resolveRules(swap);
  const pose: Pose = {};
  const missing: RetargetBone[] = [];

  for (const bone of RETARGET_TARGET_BONES) {
    const rule = rules[bone];
    const src = lookupSource(rule.from, input);
    if (!src) {
      missing.push(bone);
      continue;
    }
    const scaled: XYZ = {
      x: src.x * rule.weight,
      y: src.y * rule.weight,
      z: src.z * rule.weight,
    };
    pose[bone] = eulerXYZToQuat(mapEuler(scaled, rule.axes));
  }

  return { pose, missing };
}

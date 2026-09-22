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

/**
 * 参与**校准**的骨骼（上半身 + 头 + 腕）。
 *
 * 手指**刻意不在其中**：手指的"中立"就是伸直，源与目标本来就一致，
 * 给它 30 根骨骼各算一个修正量只会多出 30 个出错的地方，
 * 而且"标定时手指是蜷着的"会立刻污染修正量。
 * 校准的可信度自检也只看这一批。
 */
export const CALIBRATED_BONES = [
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

/** 手指的关节段名（VRM 与 Kalidokit 一致，拇指除外） */
const FINGER_PARTS = ['Proximal', 'Intermediate', 'Distal'] as const;
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;

/** VRM 的手指关节：`${侧}${指}${段}`，拇指多一根 Metacarpal */
const fingerBone = (side: 'left' | 'right', finger: string, part: string) =>
  `${side}${finger}${part}`;

/** 四指 × 3 段 × 2 侧 + 拇指 3 段 × 2 侧 = 30 根 */
export const FINGER_TARGET_BONES = [
  ...(['left', 'right'] as const).flatMap((side) => [
    ...FINGERS.flatMap((f) => FINGER_PARTS.map((p) => fingerBone(side, f, p))),
    // 拇指在 VRM 里是 Metacarpal/Proximal/Distal（Kalidokit 是 Proximal/Intermediate/Distal，
    // 整体挪一格：CMC→Metacarpal、MCP→Proximal、IP→Distal）
    fingerBone(side, 'Thumb', 'Metacarpal'),
    fingerBone(side, 'Thumb', 'Proximal'),
    fingerBone(side, 'Thumb', 'Distal'),
  ]),
] as const;

/**
 * G2 驱动的全部骨骼（上半身 + 头 + 腕 + 手指）。
 * 腿、根位移、表情仍不进。
 */
export const RETARGET_TARGET_BONES = [
  ...CALIBRATED_BONES,
  ...FINGER_TARGET_BONES,
] as const;

export type RetargetBone = (typeof RETARGET_TARGET_BONES)[number];

export type Axis = 'x' | 'y' | 'z';
export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** 一根目标轴取自来源的哪根轴、什么符号。sign 为 0 表示"这根轴不映射"（保持基础站姿）。 */
export interface AxisSpec {
  axis: Axis;
  sign: 1 | -1 | 0;
}

/**
 * 目标欧拉三元组：[目标X, 目标Y, 目标Z] 各自的取法。
 * 允许重复取同一根来源轴（有些 rig 空间一个分量承载两种信息）。
 */
export type AxisTriple = readonly [AxisSpec, AxisSpec, AxisSpec];

/**
 * 来源属于哪一路输出。
 *
 * 显式声明而不是靠键名嗅探 —— 三路输出（姿态 / 面部 / 手部）的键名会长得很像，
 * 靠字符串猜迟早会串。
 */
export type RuleScope = 'pose' | 'face' | 'hand';

/** 单根目标骨骼的重定向规则 */
export interface BoneRule {
  /** Kalidokit 输出里的键名 */
  from: string;
  /** 取多少。脊柱/头颈要拆成两段时用（0.35 / 0.65） */
  weight: number;
  /** 轴映射与符号 —— ★ 标定的主要落点 */
  axes: AxisTriple;
  /**
   * 来源在哪个输出里。默认 'pose'。
   * scope 为 'hand' 时，**左右由 `from` 的前缀决定**（`Right*` → input.hands.right，
   * `Left*` → input.hands.left），所以交换左右时只要换 `from` 就自动跟着走。
   */
  scope?: RuleScope;
}

const ax = (axis: Axis, sign: 1 | -1 | 0 = 1): AxisSpec => ({ axis, sign });

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
  // 手臂三段
  ['rightUpperArm', 'leftUpperArm'],
  ['rightLowerArm', 'leftLowerArm'],
  ['rightHand', 'leftHand'],
  // ★ 手指 15 对 × 2（四指 3 段 + 拇指 3 段）
  //   漏掉这些会得到"手臂对了、手指反了" —— 而且因为手指小、动作快，
  //   现场很容易被当成"跟踪不准"而不是"映射漏了"。
  ...(['Index', 'Middle', 'Ring', 'Little'] as const).flatMap((f) =>
    (['Proximal', 'Intermediate', 'Distal'] as const).map(
      (part) => [`right${f}${part}`, `left${f}${part}`] as const,
    ),
  ),
  ...(['Metacarpal', 'Proximal', 'Distal'] as const).map(
    (part) => [`rightThumb${part}`, `leftThumb${part}`] as const,
  ),
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
 * ★ 需标定的常量 ③：头颈与脊柱的轴映射。
 *
 * 之前偷懒让它们共用 ARM_AXES —— 那是不对的：手臂的 rig 空间来自 `rigArm()`
 * （里面有 invert / 非线性耦合 / clamp），而头颈来自 `FaceSolver.calcHead()`、
 * 脊柱来自 `calcHips()`，**三套完全不同的推导**，不可能共用同一组轴符号。
 *
 * 实测反馈：抬臂方向已对，但**转头方向是反的** —— 正是这个偷懒的后果。
 * 现在它们各自独立，探针一出结果只改这里。
 *
 * 待填（用标定探针「头向自身左转」那一条）：
 *   G1 已实测我们的约定：头向角色自身左 = 绕 Y 正方向
 *   需要的只是确认 Kalidokit 的 Face.head 哪个分量承载偏航、符号如何
 */
const HEAD_AXES: AxisTriple = [ax('x', 1), ax('y', 1), ax('z', -1)];
const SPINE_AXES: AxisTriple = [ax('x', 1), ax('y', 1), ax('z', -1)];

/**
 * ★ 需标定的常量 ④：手指与腕部的轴映射。
 *
 * 【已实测的部分】手指骨骼的轴语义（几何探针，双手都测了）：
 *   · 绕 X 转 → 指尖几乎不动（0.03–0.18cm）  → **X = 手指长轴**
 *   · 绕 Y 转 → 指尖沿"掌指关节连线"移动      → Y = 张开/并拢
 *   · 绕 Z 转 → 指尖沿**手掌法线**移动          → **Z = 弯曲** ✅
 *   双手结论一致，且**弯曲都是 +Z**（不按左右翻转）。
 *   `hand` 骨骼同样测了：X=自转(twist)、Y=尺桡偏、Z=屈伸；也是双手同号。
 *
 * 【由源码推出的部分】符号：
 *   kalidokit 的 rigFingers 里
 *       trackedFinger.z = clamp(z * -PI * invert, side===RIGHT ? -PI : 0, side===RIGHT ? 0 : PI)
 *   即 **右手恒负、左手恒正**。而我们双手弯曲都是 +Z，所以基准符号必须按侧区分：
 *       right: z = −1（右手负 → 我们的正）
 *       left : z = +1（左手正 → 我们的正）
 *   这也解释了为什么手指**不能**照搬手臂的"两侧同号"。
 *
 * 【未实测的部分】腕部三个轴的符号（Kalidokit 的 Wrist.x=twist / z=左右，都乘了 invert；
 *   y 的钳位左右不对称）。现在按与手指相同的按侧模式给初值，
 *   用标定探针（选「手腕内旋」这类动作）可以一轮定下来。
 */
const HAND_AXES: Record<'right' | 'left', AxisTriple> = {
  right: [ax('x', 1), ax('y', 1), ax('z', -1)],
  left: [ax('x', 1), ax('y', 1), ax('z', 1)],
};

/**
 * 腕部：X=自转（旋前/旋后）、Y=尺桡偏、Z=屈伸。
 * Kalidokit 的 Wrist 顺序是 x=twist / z=左右，故 **Y←z、Z←y**。
 *
 * ★ X 的符号取 −1（两侧同号），依据：
 *   · Kalidokit：`Wrist.x = clamp(x * 2 * invert, ...)` → 右侧 ×2、左侧 ×−2，
 *     两侧**相反**
 *   · 我们的 rig：右臂长轴 +X、左臂长轴 −X（T-pose 向两侧伸展），
 *     同一个物理拧转在两边的坐标符号也**相反**
 *   → "相反"对上"相反"，所以基准符号应当**两侧同号**。
 *     （对比：手指的弯曲我们两侧都是 +Z，而 Kalidokit 是右负左正 →
 *      那边的基准符号就必须两侧异号。判断依据是"两侧的约定是否同类"。)
 *
 * 另外 X 是镜面法线，`MIRROR_ODD_AXES` 只翻 Y/Z，所以换左右不影响自转 ——
 * 上面这个基准值在任何 swapLeftRight 配置下都生效。
 *
 * 实测反馈：初值写 +1 时"手腕相对于前臂的旋转是反的"（用户实机）。改为 −1。
 */
const WRIST_MAP: Record<'right' | 'left', AxisTriple> = {
  right: [ax('x', -1), ax('z', -1), ax('y', -1)],
  left: [ax('x', -1), ax('z', 1), ax('y', 1)],
};

/** 拇指：Kalidokit 的 z 是弯曲主力，x/y 是做对掌的修正项 */
const THUMB_MAP: Record<'right' | 'left', AxisTriple> = {
  right: [ax('x', 0), ax('y', -1), ax('z', -1)],
  left: [ax('x', 0), ax('y', 1), ax('z', 1)],
};

/**
 * 骨骼规则表。
 *
 * 脊柱拆两段（spine 35% / chest 65%）、头颈拆两段（neck 35% / head 65%）——
 * 这是计划定的比例：让弯曲分散到两段，避免单关节折断。
 * 肩（shoulder）**刻意不驱动**，保持 BASE_STANDING_POSE：
 * Kalidokit 没有稳定的肩骨输出，硬驱动会抖。
 */
/**
 * 手指规则的生成。
 *
 * 四指：VRM `${side}${Finger}${Part}` ← Kalidokit `${Side}${Finger}${Part}`（同名）
 * 拇指：VRM 是 Metacarpal/Proximal/Distal，Kalidokit 是 Proximal/Intermediate/Distal
 *       → 整体挪一格（CMC→Metacarpal、MCP→Proximal、IP→Distal）
 *       VRM 的 ThumbMetacarpal 对应 Kalidokit 的 ThumbProximal；
 *       我们只取弯曲（z）与张开（y），不自转（x 的 sign=0）——
 *       Kalidokit 的拇指 x 是"对掌"修正项，不是绕长轴自转，硬映射会更糟。
 */
function buildFingerRules(): Record<string, BoneRule> {
  const out: Record<string, BoneRule> = {};
  const sides = [
    { vrm: 'right', kd: 'Right' },
    { vrm: 'left', kd: 'Left' },
  ] as const;

  for (const { vrm, kd } of sides) {
    for (const finger of FINGERS) {
      for (const part of FINGER_PARTS) {
        out[fingerBone(vrm, finger, part)] = {
          from: `${kd}${finger}${part}`,
          weight: 1,
          axes: HAND_AXES[vrm],
          scope: 'hand',
        };
      }
    }
    // 拇指三根：名称错位一格
    out[fingerBone(vrm, 'Thumb', 'Metacarpal')] = {
      from: `${kd}ThumbProximal`,
      weight: 1,
      axes: THUMB_MAP[vrm],
      scope: 'hand',
    };
    out[fingerBone(vrm, 'Thumb', 'Proximal')] = {
      from: `${kd}ThumbIntermediate`,
      weight: 1,
      axes: THUMB_MAP[vrm],
      scope: 'hand',
    };
    out[fingerBone(vrm, 'Thumb', 'Distal')] = {
      from: `${kd}ThumbDistal`,
      weight: 1,
      axes: THUMB_MAP[vrm],
      scope: 'hand',
    };
  }
  return out;
}

export const RETARGET_RULES: Readonly<Record<RetargetBone, BoneRule>> = {
  spine: { from: 'Spine', weight: 0.35, axes: SPINE_AXES },
  chest: { from: 'Spine', weight: 0.65, axes: SPINE_AXES },
  // ★ scope 必须显式写 'face'：lookupSource 是按 scope 分支的，
  //   漏写就会去 pose 输出里找 'Face.head'，永远取不到 ——
  //   而症状是"头颈完全不动"，很容易被当成 FaceSolver 没输出。
  neck: { from: 'Face.head', weight: 0.35, axes: HEAD_AXES, scope: 'face' },
  head: { from: 'Face.head', weight: 0.65, axes: HEAD_AXES, scope: 'face' },
  rightUpperArm: { from: 'RightUpperArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  rightLowerArm: { from: 'RightLowerArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  leftUpperArm: { from: 'LeftUpperArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  leftLowerArm: { from: 'LeftLowerArm', weight: ARM_REST_WEIGHT, axes: ARM_AXES },
  // ★ 腕部改用 `Hand.solve` 的 Wrist —— `Pose.solve` 的 Hand 只用身体点 15/17/19，
  //   而且 x 完全不赋值（没有自转）。HandSolver 的 Wrist 有 x=自转。
  rightHand: { from: 'RightWrist', weight: 1, axes: WRIST_MAP.right, scope: 'hand' },
  leftHand: { from: 'LeftWrist', weight: 1, axes: WRIST_MAP.left, scope: 'hand' },
  ...(buildFingerRules() as Record<RetargetBone, BoneRule>),
} as Record<RetargetBone, BoneRule>;

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

/**
 * 给某一只手的**关键点**解算时，`side` 参数该传哪一侧。
 *
 * 必须与 `swapLeftRight` 保持同一套约定：Kalidokit 的 `Right*` 键读的是
 * MediaPipe 的 `left_*` 命名（F3 源码实锤），手部沿用同一套命名。
 * 两边不一致就会出现"手臂对了、手指反了"。
 */
/**
 * 成对骨骼覆盖自检。
 *
 * 用它而不是靠人记：新增一根带左右的骨骼却忘了加进 SIDED_PAIRS，
 * 症状是"交换左右后这根骨骼没跟着换"，很难联想到是清单漏了。
 * （写手指时就真的漏过一次。）
 */
export function findUnpairedSidedBones(): string[] {
  const paired = new Set(SIDED_PAIRS.flatMap(([a, b]) => [a as string, b as string]));
  return RETARGET_TARGET_BONES.filter((b) => {
    const s = b as string;
    if (s.startsWith('right')) return !paired.has(s) && !paired.has('left' + s.slice(5));
    if (s.startsWith('left')) return !paired.has(s) && !paired.has('right' + s.slice(4));
    return false; // 中线骨骼不需要成对
  });
}

export function handSideFor(landmarkSide: 'left' | 'right'): 'Right' | 'Left' {
  if (swapLeftRight) return landmarkSide === 'left' ? 'Right' : 'Left';
  return landmarkSide === 'left' ? 'Left' : 'Right';
}

/**
 * 把两只手的解算结果装进 `RetargetInput.hands`。
 *
 * ★ 桶名用 **Kalidokit 的侧名**（handSideFor 的返回值），保证与 `from` 前缀同源。
 *   这个函数的存在就是为了让"页面接线"和"重定向查找"不可能用两套命名 ——
 *   之前正是这两处不一致，导致手指完全不动。
 */
export function buildHandsInput(
  fromRightLandmarks: KalidokitHandLike | null,
  fromLeftLandmarks: KalidokitHandLike | null,
): { Right?: KalidokitHandLike | null; Left?: KalidokitHandLike | null } {
  const out: { Right?: KalidokitHandLike | null; Left?: KalidokitHandLike | null } = {};
  const sideOfRight = handSideFor('right');
  const sideOfLeft = handSideFor('left');
  out[sideOfRight] = fromRightLandmarks;
  out[sideOfLeft] = fromLeftLandmarks;
  return out;
}

/** 把规则表按 swapLeftRight 解析成「目标骨骼 → 实际使用的规则」 */
export function resolveRules(swap: boolean = swapLeftRight): Record<RetargetBone, BoneRule> {
  const out = {} as Record<RetargetBone, BoneRule>;
  for (const bone of RETARGET_TARGET_BONES) out[bone] = RETARGET_RULES[bone];
  if (swap) {
    for (const [a, b] of SIDED_PAIRS) {
      const ra = out[a];
      const rb = out[b];
      // ★ 两件事必须一起做：
      //   1) 来源键对调
      //   2) **目标自己的**轴约定做镜像（注意不是"换进来的那个来源"的轴）
      // 第 2 条容易被写错。对左右同号的手臂看不出来（两者等价），
      // 但对**左右异号**的手指就会错 —— 手指的 Kalidokit 输出右负左正，
      // 而我们的弯曲方向双手都是 +Z，所以基准符号必须按侧区分。
      // 镜像作用在目标上才是对的语义：镜像描述的是"这根骨骼坐在镜线的哪一侧"。
      out[a] = { ...rb, weight: ra.weight, axes: mirrorAxes(ra.axes) };
      out[b] = { ...ra, weight: rb.weight, axes: mirrorAxes(rb.axes) };
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

/**
 * Kalidokit HandSolver 的输出形状：`{ RightWrist: {x,y,z}, RightIndexProximal: {...}, ... }`
 * 在这里定义（而不是从 solver 引入），是为了让本文件保持零依赖 —— 它要被 Node 直接加载。
 */
export type KalidokitHandLike = Record<string, XYZ | null | undefined>;

export interface KalidokitFaceLike {
  head?: XYZ | null;
  [key: string]: unknown;
}

/**
 * 手部来源。
 *
 * ★ 分桶按 **Kalidokit 的键前缀**命名，不是按"来自哪只手的关键点"。
 *   这一点很关键，而且踩过：页面用 `handSideFor('left')`（swapLeftRight=true 时是 'Right'）
 *   去解 `leftHandLandmarks`，于是输出的键全是 `Right*`。
 *   若分桶叫 `left`，那 `from: 'LeftIndexProximal'` 就会去 `hands.left` 里找一个
 *   名叫 `LeftIndexProximal` 的键 —— 两边各自自洽、**合起来永远取不到**，
 *   症状就是"手指完全不动"而且不报错。
 *
 *   改成按键前缀分桶后：
 *     `hands.Right` = 用 side='Right' 解出来的那份（内部键都是 Right*）
 *     `hands.Left`  = 用 side='Left'  解出来的那份（内部键都是 Left*）
 *   于是 `from` 的“查哪个桶”与“查哪个键”来自同一个前缀，不可能不一致。
 */
export interface RetargetInput {
  pose: KalidokitPoseLike | null;
  face?: KalidokitFaceLike | null;
  hands?: {
    Right?: KalidokitHandLike | null;
    Left?: KalidokitHandLike | null;
  } | null;
}

export interface RetargetOutput {
  /** 目标骨骼 → 绝对局部四元数（未叠加基础站姿，也未做校准） */
  pose: Pose;
  /** 来源缺失、没能算出来的骨骼 */
  missing: RetargetBone[];
}

/** 取来源值。scope 决定去哪一路输出里找；hand 的左右由 `from` 前缀决定。 */
function lookupSource(rule: BoneRule, input: RetargetInput): XYZ | null {
  const { from, scope = 'pose' } = rule;
  if (scope === 'face') {
    const key = from.startsWith('Face.') ? from.slice('Face.'.length) : from;
    const v = input.face?.[key];
    return isXYZ(v) ? v : null;
  }
  if (scope === 'hand') {
    // `from` 的前缀同时决定「查哪个桶」与「查哪个键」—— 两者来自同一个前缀，
    // 所以不可能出现"桶对了键不对"这种静默失效。
    const side = from.startsWith('Right') ? 'Right' : from.startsWith('Left') ? 'Left' : null;
    if (!side) return null;
    const v = input.hands?.[side]?.[from];
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
    const src = lookupSource(rule, input);
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

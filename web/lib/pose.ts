/**
 * 姿态数学与轴向约定 —— **自包含**（不 import 任何东西），
 * 这样 tools/gen-clips.mjs 可以用 Node 的类型擦除直接 import 本文件。
 *
 * ⚠️ 本文件里的轴向约定是**实测得出**，不是推导的。
 * 测量方法：逐个骨骼施加「绕世界某轴 60°/45°」的四元数，读末端骨骼的世界坐标变化。
 * 原始数据见 docs/P0-A-第一步-方案与验收.md 与 docs/G1-验收记录.md。
 *
 * 测量环境：Seed-san（VRM 1.0），角色面向 +Z、Y 向上、相机在 +Z。
 * 由此推得一条极容易搞错的事实：
 *   **角色自身右侧 = 世界 -X**（因为角色面向 +Z，它的右手在我们视角的左边）
 * 实测锚点：参考姿态下 rightHand 世界 x = -0.616，leftHand x = +0.616。
 */

export type Quat = [number, number, number, number];
export type Pose = Record<string, Quat>;

export const IDENTITY: Quat = [0, 0, 0, 1];

/** 绕 ***世界轴***（= normalized 参考姿态的规范轴）旋转，右手定则，角度制 */
export function rotQ(axis: 'X' | 'Y' | 'Z', deg: number): Quat {
  const r = (deg * Math.PI) / 180;
  const s = Math.sin(r / 2);
  const c = Math.cos(r / 2);
  if (axis === 'X') return [s, 0, 0, c];
  if (axis === 'Y') return [0, s, 0, c];
  return [0, 0, s, c];
}

/** 四元数乘法：结果先施加 b 再施加 a（与库内部 q_a * q_b 的约定一致） */
export function mulQ(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function normalizeQ(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n === 0 || !Number.isFinite(n)) return [...IDENTITY];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** 依次叠加多个「绕轴旋转」，按传入顺序从里到外合成 */
export function compose(...parts: Quat[]): Quat {
  return normalizeQ(parts.reduce((acc, p) => mulQ(acc, p), IDENTITY));
}

/**
 * 轴向约定表（全部实测，见文件头）。
 *
 *  轴   语义              典型用途
 *  ───  ────────────────  ────────────────────────────────────────
 *  X    角色左右轴/俯仰    手臂前摆后摆、低头抬头、手臂自转轴（T-pose 下）
 *  Y    角色上下轴/偏航    转头、手臂在水平面内划动
 *  Z    角色前后轴/侧摆    抬臂与垂臂（额状面内）
 *
 *  动作          骨骼              轴  符号
 *  ────────────  ────────────────  ──  ──────
 *  抬右臂/抬左臂  *UpperArm         Z   − / +
 *  右肘屈/左肘屈  *LowerArm         Z   − / +   （前臂在额状面内抬起，正面可见）
 *  头向自身左/右  head              Y   + / −
 */
export const RIG_AXIS_CONVENTION = {
  measuredWith: 'Seed-san (VRM 1.0), 角色面向 +Z, 世界轴语义',
  characterRightAxis: '-X',
  raiseArm: { bone: 'UpperArm', axis: 'Z', right: -1, left: +1 },
  bendElbow: { bone: 'LowerArm', axis: 'Z', right: -1, left: +1 },
  turnHead: { bone: 'head', axis: 'Y', toCharacterLeft: +1, toCharacterRight: -1 },
  armSwing: { bone: 'UpperArm', axis: 'X', forward: -1, backward: +1 },
  pitch: { bone: 'head', axis: 'X', lookDown: +1, lookUp: -1 },
} as const;

/** 双臂下垂时上臂需要的侧摆角度（实测：Z+72° 使右手世界 y 从 1.237 降到 0.794） */
export const ARM_DOWN_DEG = 72;
/** 自然站姿的轻微屈肘 */
export const NATURAL_ELBOW_DEG = 8;

/**
 * 基础站姿（日常播放用）：双臂自然下垂，不是参考姿态。
 *
 * ⚠️ 参考姿态（normalized 骨骼全为单位四元数）实测等于 **T-pose**，
 * 所以不能把 normalized 的 identity 当待机姿态 —— 那份姿态要用本常量显式表达。
 */
export const BASE_STANDING_POSE: Pose = {
  rightUpperArm: rotQ('Z', ARM_DOWN_DEG),
  leftUpperArm: rotQ('Z', -ARM_DOWN_DEG),
  // 轻微屈肘：绕 Z（参考姿态下的肘屈曲轴），正面看得见
  rightLowerArm: rotQ('Z', -NATURAL_ELBOW_DEG),
  leftLowerArm: rotQ('Z', NATURAL_ELBOW_DEG),
};

/** 参考姿态：normalized 骨骼全为单位四元数（用于坐标校准，不作为待机姿态） */
export const REST_POSE: Pose = {};

/** 取某骨骼在基础站姿下的四元数，未显式定义的骨骼回落到单位四元数 */
export function baseQuatOf(bone: string): Quat {
  return BASE_STANDING_POSE[bone] ?? IDENTITY;
}

/** 在基础站姿之上叠加一个「绕轴旋转」（左侧乘，与实测的合成方向一致） */
export function fromBase(bone: string, axis: 'X' | 'Y' | 'Z', deg: number): Quat {
  return mulQ(rotQ(axis, deg), baseQuatOf(bone));
}

/** 生成一个姿态：未列出的骨骼取基础站姿值 */
export function poseWith(overrides: Pose): Pose {
  return { ...BASE_STANDING_POSE, ...overrides };
}

// ---------------------------------------------------------------------------
// 关键帧烘焙（生成器与播放器共用同一套插值，保证"按秒采样与帧率无关"）
// ---------------------------------------------------------------------------

/** 平滑缓动：两端一阶导为 0，动作不会有突然的加速 */
export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export interface Keyframe {
  /** 秒 */
  t: number;
  pose: Pose;
}

/** 收集一组关键帧涉及到的全部骨骼名（即 clip 的 mask） */
export function keyframeBones(keys: Keyframe[]): string[] {
  const set = new Set<string>();
  for (const k of keys) for (const b of Object.keys(k.pose)) set.add(b);
  return [...set].sort();
}

/** 取某骨骼在某个关键帧上的四元数；未列出则用基础站姿值 */
function keyQuat(pose: Pose, bone: string): Quat {
  return pose[bone] ?? baseQuatOf(bone);
}

/** 在两个关键帧之间按秒数采样（缓动 + 最短路径 slerp） */
export function sampleKeyframes(keys: Keyframe[], bone: string, timeSec: number): Quat {
  if (keys.length === 0) return baseQuatOf(bone);
  if (timeSec <= keys[0].t) return keyQuat(keys[0].pose, bone);
  const last = keys[keys.length - 1];
  if (timeSec >= last.t) return keyQuat(last.pose, bone);

  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (timeSec <= b.t) {
      const span = b.t - a.t;
      const raw = span <= 0 ? 1 : (timeSec - a.t) / span;
      const t = smoothstep(raw);
      return slerp(keyQuat(a.pose, bone), keyQuat(b.pose, bone), t);
    }
  }
  return keyQuat(last.pose, bone);
}

/**
 * 最短路径 slerp。
 * 与 web/lib/clip-spec.ts 的 slerpQuat 是同一算法；此文件保持自包含，
 * 故这里再实现一次 —— 改动插值必须两处同时改，并有测试比对（见 tests/clip-interp.test.mjs）。
 */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQ([a[0] + t * (bx - a[0]), a[1] + t * (by - a[1]), a[2] + t * (bz - a[2]), a[3] + t * (bw - a[3])]);
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  return [a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1];
}

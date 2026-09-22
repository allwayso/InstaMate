/**
 * Kalidokit 求解器包装。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  两个必须知道的坑
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **kalidokit 不能在 Node 里加载**：它的 package.json 里 main 指向
 *     `dist/index.js`，而那是 ESM 且用无扩展名的目录导入（`from "./PoseSolver"`），
 *     Node 会报 `Directory import is not supported`。打包器（Turbopack/webpack）能解析。
 *     → 所以本文件**不在顶层 import kalidokit**，只在工厂函数里动态 import。
 *       这样 Node 侧仍可加载本模块（测试注入假 solver），浏览器侧正常打包。
 *
 *  2. **`lm3d` 必须是 `poseWorldLandmarks`（单位米）**，不能是归一化 [0,1] 的点。
 *     PoseSolver.solve 内部有一句离屏守卫：
 *         rightHandOffscreen = lm3d[15].y > 0.1 || (lm3d[15].visibility ?? 0) < 0.23 || ...
 *     `> 0.1` 是**米**语义的阈值。喂归一化点进去会让它恒为真，整条手臂被乘 0
 *     并写成 RestingDefault（RightUpperArm.z = -1.25），表现成"对输入毫无反应"，
 *     极易误判成 kalidokit 坏了。（实测：归一化 → z 恒为 −1.25；米制 → z 随姿态变。）
 */
import type { Landmark, MocapRawFrame } from './mocap-types.ts';
import type { KalidokitFaceLike, KalidokitPoseLike, XYZ } from './retarget-profile.ts';

export const KALIDOKIT_VERSION = '1.1.5';

/** Kalidokit 的 PoseSolver.solve 期望的形状（只列出我们用到的） */
export interface SolverVector {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * PoseSolver 会真正读到的身体关键点索引。
 * 取自 kalidokit@1.1.5 源码：
 *   calcArms: 11,12,13,14,15,16（肩肘腕）、17,18,19,20（手）
 *   离屏守卫: 15,16（腕）、23,24
 * 这些点缺一个就会算出 NaN 或触发错误的离屏判定 —— 所以缺了就**整帧不求解**，
 * 交给平滑器的"保持上一有效姿态"去兜，而不是塞 0 假装有数据。
 */
export const POSE_CRITICAL_INDICES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24] as const;

/** 面部至少要有这么多点才拿去解算 */
const FACE_MIN_POINTS = 400;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 把 MediaPipe 的关键点转成我们可空的口径（缺失写 null，不伪造 0） */
export function toLandmarks(raw: unknown): Landmark[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      x: num(o.x),
      y: num(o.y),
      z: num(o.z),
      visibility: num(o.visibility),
    };
  });
}

/**
 * 身体关键点 → Kalidokit 输入。
 *
 * 关键索引缺失时返回 null（不求解），其余索引缺失填 0 —— 因为 Kalidokit 会
 * 对数组做算术，塞 null 会全场变成 NaN；而"填 0"只影响它不读的位置
 * （腿脚等，我们 enableLegs:false）。
 */
export function toSolverVectors(lms: Landmark[] | null, requireAll = false): SolverVector[] | null {
  if (!lms || lms.length < 25) return null;
  for (const i of POSE_CRITICAL_INDICES) {
    const p = lms[i];
    if (!p || p.x === null || p.y === null || p.z === null) return null;
  }
  if (requireAll && lms.some((p) => !p || p.x === null)) return null;

  return lms.map((p) => ({
    x: p.x ?? 0,
    y: p.y ?? 0,
    z: p.z ?? 0,
    ...(p.visibility !== null ? { visibility: p.visibility } : {}),
  }));
}

/** 面部关键点 → Kalidokit Face 输入。点太少就返回 null（跳过头部解算） */
export function toSolverFace(lms: Landmark[] | null): SolverVector[] | null {
  if (!lms || lms.length < FACE_MIN_POINTS) return null;
  return lms.map((p) => ({ x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 }));
}

export interface SolveOptions {
  /** 视频尺寸；Kalidokit 在 tfjs 模式下会用来归一化，mediapipe 模式下仅用于透视相关的判定 */
  imageSize: { width: number; height: number } | null;
  video?: HTMLVideoElement | null;
  /** 是否解算腿部。G2 固定 false */
  enableLegs?: boolean;
}

/**
 * 求解器接口。
 *
 * 抽象出来是为了**可注入**：kalidokit 在 Node 里加载不了，所以纯逻辑测试要能塞一个
 * 假实现进去；同时页面上的"轴向标定"也能用固定输入回放，不必每次都真抬胳膊。
 */
export interface MocapSolver {
  readonly name: string;
  readonly version: string;
  solvePose(pose: Landmark[] | null, world: Landmark[] | null, opts: SolveOptions): KalidokitPoseLike | null;
  solveFace(face: Landmark[] | null, opts: SolveOptions): KalidokitFaceLike | null;
}

/** 从 Holistic 的一帧结果里切出求解器需要的两组身体点 */
export function extractPoseInputs(frame: MocapRawFrame): {
  pose: SolverVector[] | null;
  world: SolverVector[] | null;
} {
  return {
    pose: toSolverVectors(frame.poseLandmarks),
    world: toSolverVectors(frame.poseWorldLandmarks),
  };
}

/** 用真实 kalidokit 创建求解器（只在浏览器里调用） */
export async function createKalidokitSolver(): Promise<MocapSolver> {
  // ★ 动态 import：见文件头第 1 条。顶层 import 会让 Node 侧无法加载本模块。
  const mod = (await import('kalidokit')) as unknown as {
    Pose: {
      solve: (
        lm3d: SolverVector[],
        lm2d: SolverVector[],
        opts: Record<string, unknown>,
      ) => KalidokitPoseLike | undefined;
    };
    Face: {
      solve: (lm: SolverVector[], opts: Record<string, unknown>) => KalidokitFaceLike | undefined;
    };
  };

  return {
    name: 'kalidokit',
    version: KALIDOKIT_VERSION,

    solvePose(pose, world, opts) {
      const v2 = toSolverVectors(pose);
      const v3 = toSolverVectors(world);
      // ★ lm3d 必须传世界坐标（米），否则会被离屏守卫打回 RestingDefault
      if (!v2 || !v3) return null;
      const out = mod.Pose.solve(v3, v2, {
        runtime: 'mediapipe',
        video: opts.video ?? null,
        imageSize: opts.imageSize,
        enableLegs: opts.enableLegs ?? false,
      });
      return out ?? null;
    },

    solveFace(face, opts) {
      const v = toSolverFace(face);
      if (!v) return null;
      const out = mod.Face.solve(v, {
        runtime: 'mediapipe',
        video: opts.video ?? null,
        imageSize: opts.imageSize,
      });
      return out ?? null;
    },
  };
}

/** 测试与标定用的假求解器：按索引返回预置结果 */
export function createStubSolver(
  poseByKey: Record<string, KalidokitPoseLike> = {},
  keys: readonly string[] = [],
): MocapSolver & { calls: number } {
  let calls = 0;
  let i = 0;
  return {
    name: 'stub',
    version: 'test',
    get calls() {
      return calls;
    },
    solvePose() {
      calls++;
      const k = keys.length ? keys[Math.min(i++, keys.length - 1)] : undefined;
      return k ? (poseByKey[k] ?? null) : null;
    },
    solveFace() {
      return null;
    },
  };
}

/** 取 XYZ 的分量（Kalidokit 返回对象有 x/y/z，但类型上是 Vector 类） */
export function asXYZ(v: XYZ | null | undefined): XYZ | null {
  if (!v) return null;
  const { x, y, z } = v as XYZ;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

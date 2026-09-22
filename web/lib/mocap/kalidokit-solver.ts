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
import type { KalidokitFaceLike, KalidokitHandLike, KalidokitPoseLike, XYZ } from './retarget-profile.ts';

export const KALIDOKIT_VERSION = '1.1.5';

/** Kalidokit 的 PoseSolver.solve 期望的形状（只列出我们用到的） */
export interface SolverVector {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * Kalidokit 的 Side 常量（`constants.js` 里 RIGHT='Right' / LEFT='Left'）。
 * 写死字符串而不是 import，是为了让本模块在 Node 侧也能加载
 * （顶层 import kalidokit 会让 Node 直接挂 —— 见文件头第 1 条）。
 */
export const SOLVER_SIDE = { right: 'Right', left: 'Left' } as const;

/** 手部关键点是否够用（21 点且坐标齐全） */
export function isHandUsable(hand: Landmark[] | null): boolean {
  if (!hand || hand.length < 21) return false;
  for (let i = 0; i < 21; i++) {
    const p = hand[i];
    if (!p || p.x === null || p.y === null || p.z === null) return false;
  }
  return true;
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
  /**
   * 从 21 个手部关键点解算手指与腕部。
   *
   * ★ 这是与 `solvePose` **完全独立**的一条通路：
   *   · `solvePose` 的 Hand 只用身体点 15/17/19 推腕部（粗，且 x 完全不赋值 → 没有自转）
   *   · `solveHand` 用 21 个手部点算出 16 个关节：Wrist + 5 指 × 3 段
   *   Kalidokit 的 HandSolver 早就提供它，只是我们之前没调用。
   *
   * `side` 传 'Right' / 'Left'（Kalidokit 的 Side 枚举值）。
   * 注意与 F3 的一致性：Kalidokit 的 Right 对应 MediaPipe 的 left_* 命名，
   * 所以这里传哪一侧要跟 `swapLeftRight` 保持同一套约定。
   */
  solveHand(hand: Landmark[] | null, side: 'Right' | 'Left'): KalidokitHandLike | null;
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

/** 缓存已加载的模块，供下面的回归探针复用（避免二次 import） */
let cachedModule: Record<string, unknown> | null = null;

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
    Hand: {
      solve: (lm: SolverVector[], side: string) => KalidokitHandLike | undefined;
    };
  };
  cachedModule = mod as unknown as Record<string, unknown>;

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

    solveHand(hand, side) {
      // 手部 21 点，每点都必需 —— 少一个就会算出错的关节角
      if (!hand || hand.length < 21) return null;
      const v: SolverVector[] = [];
      for (let i = 0; i < 21; i++) {
        const p = hand[i];
        if (!p || p.x === null || p.y === null || p.z === null) return null;
        v.push({ x: p.x, y: p.y, z: p.z });
      }
      const out = mod.Hand.solve(v, side);
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
    solveHand() {
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


/**
 * F2 回归探针：验证 Kalidokit 的"离屏守卫"仍然存在，且我们喂的是米制世界坐标。
 *
 * 背景（这是 G2 阶段最贵的一个坑）：
 *   `PoseSolver.solve` 内部有
 *       rightHandOffscreen = lm3d[15].y > 0.1 || (lm3d[15].visibility ?? 0) < 0.23 || ...
 *   其中 `> 0.1` 是**米**语义的阈值。如果误把归一化 [0,1] 的关键点当 lm3d 传进去，
 *   `0.76 > 0.1` 恒为真 → 整条手臂被乘 0 并写成 `RestingDefault`
 *   （RightUpperArm.z = −1.25），表现成"对输入毫无反应"，
 *   极易误判成 kalidokit 坏了。
 *
 * 为什么做成运行时探针而不是单测：kalidokit 在 Node 里加载不了（见文件头第 1 条），
 * 所以这条断言只能在浏览器里跑。
 *
 * @returns null 表示模块还没加载（先启动摄像头或等页面初始化完）
 */
export function probeRestingDefaultGuard(): {
  restingDefaultZ: number;
  normalizedInputZ: number;
  meterInputZ: number;
  guardStillWorks: boolean;
  weAreSafe: boolean;
} | null {
  const mod = cachedModule as
    | {
        Pose?: { solve: (a: SolverVector[], b: SolverVector[], o: Record<string, unknown>) => { RightUpperArm?: { z?: number } } | undefined };
        Utils?: { RestingDefault?: { Pose?: { RightUpperArm?: { z?: number } } } };
      }
    | null;
  if (!mod?.Pose?.solve) return null;

  // 归一化的 33 点（x,y ∈ [0,1]）—— 手腕 y = 0.76 > 0.1
  const mkNormalized = () => {
    const a: SolverVector[] = [];
    for (let i = 0; i < 33; i++) a.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
    a[11] = { x: 0.62, y: 0.42, z: 0, visibility: 1 };
    a[12] = { x: 0.38, y: 0.42, z: 0, visibility: 1 };
    a[13] = { x: 0.70, y: 0.60, z: 0, visibility: 1 };
    a[14] = { x: 0.30, y: 0.60, z: 0, visibility: 1 };
    a[15] = { x: 0.72, y: 0.76, z: 0, visibility: 1 };
    a[16] = { x: 0.28, y: 0.76, z: 0, visibility: 1 };
    for (const i of [17, 19]) a[i] = { x: 0.72, y: 0.76, z: 0, visibility: 1 };
    for (const i of [18, 20]) a[i] = { x: 0.28, y: 0.76, z: 0, visibility: 1 };
    a[23] = { x: 0.58, y: 0.75, z: 0, visibility: 1 };
    a[24] = { x: 0.42, y: 0.75, z: 0, visibility: 1 };
    return a;
  };
  /**
   * 米制世界坐标。
   *
   * ★ 必须写**真实的人体尺寸**，不能用"把归一化坐标线性缩放"来造 ——
   *   那样会把手腕放到髋下 0.31m（`(0.76−0.5)*1.2 = +0.312`），
   *   而验收守卫判的是 `lm3d[15].y > 0.1`（腕比髋低 10cm 以上即视为垂在手边），
   *   于是"合成数据"本身就该被守卫拦下 —— 那是数据不真实，不是代码有问题。
   *   （第一次写这个探针就是这么栽的。）
   *
   * 真实站立姿态（原点在髋中心，y 向下为负）：
   *   肩 ≈ −0.50m，肘 ≈ −0.25m，腕 ≈ −0.03m，髋 = 0
   */
  const mkMeter = () => {
    const a: SolverVector[] = [];
    for (let i = 0; i < 33; i++) a.push({ x: 0, y: 0, z: 0, visibility: 1 });
    const set = (i: number, x: number, y: number) => {
      a[i] = { x, y, z: 0, visibility: 1 };
    };
    // 肩 11=左 12=右（世界 x：+ 为角色自身右？此处只需量级真实，方向不影响守卫判定）
    set(11, 0.18, -0.5);
    set(12, -0.18, -0.5);
    set(13, 0.21, -0.25);
    set(14, -0.21, -0.25);
    set(15, 0.22, -0.03); // 腕：比髋**高** 3cm —— 正是"手垂在身侧"的真实位置
    set(16, -0.22, -0.03);
    set(17, 0.22, -0.02);
    set(18, -0.22, -0.02);
    set(19, 0.22, -0.02);
    set(20, -0.22, -0.02);
    set(21, 0.20, -0.02);
    set(22, -0.20, -0.02);
    set(23, 0.10, 0); // 髋
    set(24, -0.10, 0);
    set(25, 0.10, 0.45); // 膝
    set(26, -0.10, 0.45);
    set(27, 0.10, 0.85); // 踝
    set(28, -0.10, 0.85);
    return a;
  };

  const opts = { runtime: 'mediapipe' as const, imageSize: { width: 640, height: 480 }, enableLegs: false };
  const restZ = mod.Utils?.RestingDefault?.Pose?.RightUpperArm?.z ?? -1.25;

  const norm = mkNormalized();
  const meter = mkMeter();
  const zNorm = mod.Pose.solve(norm, norm, opts)?.RightUpperArm?.z ?? NaN;
  const zMeter = mod.Pose.solve(meter, norm, opts)?.RightUpperArm?.z ?? NaN;

  const guardStillWorks = Math.abs(zNorm - restZ) < 1e-9;
  return {
    restingDefaultZ: restZ,
    normalizedInputZ: zNorm,
    meterInputZ: zMeter,
    // 守卫仍在：喂归一化坐标会被打回 RestingDefault
    guardStillWorks,
    // 我们安全：喂米制坐标不会被打回
    weAreSafe: Number.isFinite(zMeter) && Math.abs(zMeter - restZ) > 1e-6,
  };
}

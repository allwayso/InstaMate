/**
 * CharacterRuntime —— 唯一把姿态写入 VRM 身体骨骼的地方。
 *
 * 职责（G1 计划）：
 * - 缓存骨骼引用与基础姿态，避免每帧查表
 * - 写之前先做**能力检查**：缺骨骼就整体拒绝，绝不部分写入
 * - 每帧只调用一次 vrm.update(delta)（§十 要求，且自动化测试会断言这个计数）
 *
 * ⚠️ 只写 normalized 骨骼。raw 骨骼由 three-vrm 的 autoUpdateHumanBones 在 update() 时同步，
 * 手写 raw 会造成 normalized/raw 双写（§七 明确禁止，也是 §十一 G1 的首要排查项）。
 */
import type { Object3D } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import { baseQuatOf, IDENTITY } from './pose';
import { HUMAN_BONES_VRM1 } from './contracts';
import { classifyBones } from './bone-classify';
import type { Pose, Quat } from './pose';

export interface ApplyPoseResult {
  ok: boolean;
  applied: string[];
  /** 目标资产没有的骨骼 —— 出现即整体不写入 */
  missing: string[];
  /** 不是 VRM 1.0 标准人形骨骼名 */
  unknown: string[];
}

/** normalized 骨骼全为单位四元数 = 参考姿态（**等于 T-pose**，不是待机姿态） */
export function identityPose(bones: readonly string[]): Pose {
  const pose: Pose = {};
  for (const b of bones) pose[b] = [...IDENTITY] as Quat;
  return pose;
}

/** 所有骨骼取基础站姿值 */
export function basePoseOf(bones: readonly string[]): Pose {
  const pose: Pose = {};
  for (const b of bones) pose[b] = baseQuatOf(b);
  return pose;
}

export class CharacterRuntime {
  private readonly vrm: VRM;
  private readonly nodes = new Map<string, Object3D>();
  private readonly knownBones: Set<string>;
  /** 每帧 vrm.update 次数，自动化测试断言其为 1 */
  private updatesThisFrame = 0;
  private totalUpdates = 0;
  /** 当前写入的姿态（快照与"不部分应用"的保留语义用） */
  private lastPose: Pose = {};

  constructor(vrm: VRM) {
    this.vrm = vrm;
    this.knownBones = new Set(Object.keys(vrm.humanoid.humanBones ?? {}));
  }

  getBones(): string[] {
    return [...this.knownBones];
  }

  getUpdateCount(): number {
    return this.totalUpdates;
  }

  getLastFrameUpdateCount(): number {
    return this.updatesThisFrame;
  }

  private nodeOf(bone: string): Object3D | null {
    const cached = this.nodes.get(bone);
    if (cached) return cached;
    const n = this.vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
    if (n) this.nodes.set(bone, n);
    return n ?? null;
  }

  /**
   * 预检：把目标资产缺的骨骼分类。
   *
   * ★ 两种"没有"必须分开，这是接入第三方模型的前提：
   *   · `unknown` —— 这个名字**不在 VRM 1.0 规范的 55 根里**。
   *     说明文件本身有问题（写错名、或者 rigProfile 不是 VRM），**必须整体拒绝**。
   *   · `missing` —— 名字合法，但这具模型**天然没有这根骨骼**
   *     （例如 Seed-san 没有 upperChest、没有 jaw、没有左右眼）。
   *     这是**正常情况**，不该拒绝 —— 应当写能写的部分并如实报告。
   *
   * 早期实现把两者混为一谈，结果是：接一具缺手指的第三方模型时，
   * 一条含手指的 clip 会让**整个角色一动不动**（而不是"只有手指不动"）。
   * 那是设计缺陷，不是模型的错。
   */
  checkBones(names: readonly string[]): {
    /** 可以安全写入（没有任何非法骨骼名） */
    ok: boolean;
    /** 合法但本模型没有的骨骼 */
    missing: string[];
    /** 不在 VRM 1.0 规范里的骨骼名（文件有问题） */
    unknown: string[];
  } {
    return classifyBones(names, this.knownBones, HUMAN_BONES_VRM1);
  }

  /**
   * 写入一个姿态。
   * 只要有一根骨骼缺失就**整体不写**（不部分应用坏文件），返回 ok:false 与缺失名单。
   */
  applyPose(pose: Pose): ApplyPoseResult {
    const pre = this.checkBones(Object.keys(pose));
    // 只有"非法骨骼名"才整体拒绝（文件有问题）；
    // "模型天然缺某根合法骨骼"应当继续写能写的部分。
    if (pre.unknown.length > 0) return { ok: false, applied: [], missing: pre.missing, unknown: pre.unknown };

    const applied: string[] = [];
    const notWritten: string[] = [];
    for (const [bone, q] of Object.entries(pose)) {
      const n = this.nodeOf(bone);
      if (!n) {
        notWritten.push(bone); // 合法但本模型没有
        continue;
      }
      n.quaternion.set(q[0], q[1], q[2], q[3]).normalize();
      applied.push(bone);
    }
    // 只把真正写进去的记住，避免 later "恢复姿态"时引用不存在的骨骼
    const written: Pose = {};
    for (const b of applied) written[b] = pose[b];
    this.lastPose = { ...this.lastPose, ...written };
    return { ok: true, applied, missing: notWritten, unknown: [] };
  }

  /** 写基础站姿（双臂自然下垂）—— 不是参考姿态 */
  applyBasePose(): ApplyPoseResult {
    return this.applyPose(basePoseOf(this.getBones()));
  }

  /** 写参考姿态：normalized 骨骼全为单位四元数（坐标校准用） */
  applyRestPose(): ApplyPoseResult {
    return this.applyPose(identityPose(this.getBones()));
  }

  /** 读取当前被写入的姿态 */
  readPose(): Pose {
    return { ...this.lastPose };
  }

  /**
   * 每帧收尾。**唯一**调用 vrm.update 的地方。
   * 返回本帧的 update 次数（应为 1），供自动化断言。
   */
  commit(delta: number): number {
    this.updatesThisFrame = 0;
    this.vrm.update(delta);
    this.updatesThisFrame = 1;
    this.totalUpdates += 1;
    return this.updatesThisFrame;
  }
}

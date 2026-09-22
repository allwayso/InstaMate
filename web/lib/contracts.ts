/**
 * 项目接口契约 —— 唯一真相源。
 *
 * 三份契约来自 docs/Collaborate.md §三：
 *   1. CharacterController   （A 提供，C/D 只消费）
 *   2. ClipFile / clip schema（A/C 共同冻结，C 产出）
 *   3. DialogueEvent          （D 定义）
 *
 * 约束：骨骼表只在本文件与 ./human-bones-vrm1.json 出现一次。
 * tools/validate-clip.mjs 读同一份 JSON，禁止在任何地方复制第二份清单。
 */
import boneData from './human-bones-vrm1.json';
import { CLIP_SPEC, validateClip as validateClipPure } from './clip-spec';
import type { ValidationResult } from './clip-spec';

// clip v1 的规格与校验规则实现在 ./clip-spec.ts（浏览器与 CLI 共用同一份实现）。
// 这里只再做导出与注入骨骼表，避免出现第二份常量或第二套规则。
export { CLIP_SPEC, slerpQuat, normalizeClipQuaternions } from './clip-spec';
export type {
  ClipFile,
  QuaternionTuple,
  ValidationIssue,
  ValidationResult,
  ValidateOptions,
} from './clip-spec';

// ---------------------------------------------------------------------------
// rigProfile 与骨骼表
// ---------------------------------------------------------------------------

/** 项目内部 rigProfile。记录骨骼表、参考姿态、轴定义，不代表任意第三方 VRM 自动兼容。 */
export const RIG_PROFILE = 'vrm-normalized-v1' as const;
export type RigProfile = typeof RIG_PROFILE;

/** VRM 1.0 规范的全部 55 根人形骨骼（与规范 humanoid.md 逐项核对过）。 */
export const HUMAN_BONES_VRM1: readonly string[] = boneData;

/** VRM 1.0 规范中**必需**的骨骼（缺一即视为资产不合格）。 */
export const REQUIRED_BONES = ['hips', 'spine', 'head'] as const;

/** 项目实际使用的骨骼：任一缺失都会让对应功能失效。 */
export const PROJECT_USED_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
] as const;

// ---------------------------------------------------------------------------
// 1. CharacterController（A 提供，C/D 只消费）
// ---------------------------------------------------------------------------

export const CHARACTER_STATES = [
  'idle',
  'noticing',
  'tracking',
  'listening',
  'thinking',
  'speaking',
] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];

/** 业务情绪。neutral 表示**清除**业务情绪权重，不要求资产存在同名表情。 */
export const EMOTIONS = ['happy', 'sad', 'surprised', 'neutral'] as const;
export type Emotion = (typeof EMOTIONS)[number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayClipOptions {
  /** 秒 */
  fadeIn?: number;
  /** 秒 */
  fadeOut?: number;
  loop?: boolean;
}

/**
 * 补充语义（§三.1）：
 * - setLookTarget 接收 Three.js 世界坐标、单位米；传 null 时平滑回正；
 * - onStateChange 返回退订函数；
 * - 非循环 playClip 在播放完成后 resolve，加载失败或被新动作取代时给出可识别的错误/取消结果；
 * - 调用方负责模型卸载、事件退订与 GPU 资源释放。
 */
export interface CharacterController {
  setLookTarget(pos: Vec3 | null): void;
  playClip(name: string, opts?: PlayClipOptions): Promise<void>;
  stopClip(): void;
  /** 0..1 */
  setMouthOpen(value: number): void;
  setExpression(name: Emotion): void;
  setState(state: CharacterState): void;
  onStateChange(cb: (s: CharacterState) => void): () => void;
}

// ---------------------------------------------------------------------------
// 2. clip 文件结构（§三.2 + §九.2）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. 对话事件（D 定义）
// ---------------------------------------------------------------------------

export interface DialogueEvent {
  userText: string;
  replyText: string;
  emotion: Emotion;
  audioUrl: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 运行时能力探测结果
// ---------------------------------------------------------------------------

export type LookAtType = 'bone' | 'expression';

/**
 * 由 three-vrm 实例实测得到，**禁止在代码里写死**。
 * 例：示例资产 sample.vrm 是 expression 型且无 leftEye/rightEye，
 * 而 B 用 VRoid 导出的资产可能是 bone 型。
 */
export interface VrmCapabilities {
  /** VRM1 为 '1'，VRM0 为 '0'（§七：0.x 只在加载入口兼容） */
  metaVersion: '0' | '1' | null;
  /** 由 metaVersion 推出的规范版本：'1.0' / '0.x' */
  specVersion: string | null;
  assetName: string | null;
  authors: string[];
  creditNotation: string | null;
  licenseUrl: string | null;
  lookAtType: LookAtType | null;
  boneCount: number;
  missingBones: string[];
  missingProjectBones: string[];
  missingRequiredBones: string[];
  hasUpperChest: boolean;
  expressionsPreset: string[];
  expressionsCustom: string[];
  springBoneGroups: number | null;
  springBoneJoints: number;
  springBoneColliders: number;
  /** head 骨骼的世界高度（米），供相机取景用 */
  headWorldY: number | null;
  /** hips 骨骼的世界高度（米） */
  hipsWorldY: number | null;
}

// ---------------------------------------------------------------------------
// 浏览器侧校验入口：自动注入骨骼表
// ---------------------------------------------------------------------------

/**
 * 校验一个 clip（浏览器侧）。规则与 CLI 完全一致，只是自动带上骨骼表。
 * @param targetBones 目标资产实际拥有的骨骼（来自 VrmCapabilities / manifest）
 */
export function validateClipFile(
  clip: unknown,
  targetBones?: readonly string[] | null,
): ValidationResult {
  return validateClipPure(clip, { boneList: HUMAN_BONES_VRM1, targetBones: targetBones ?? null });
}

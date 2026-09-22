/**
 * VRM 加载器与能力探测（A 泳道）。
 *
 * 设计约束（docs/Collaborate.md §七 / §十 / §三.4）：
 * - 用官方方式加载：GLTFLoader + VRMLoaderPlugin，不自造解析；
 * - 只在这里做版本兼容（VRM 0.x 朝向），不把兼容逻辑散到业务代码；
 * - 能力靠探测、不写死：lookAtType / 缺失骨骼 / 表情 / 弹簧骨全部实测；
 * - 提供显式 dispose，避免多次加载泄漏 GPU 资源。
 */
import * as THREE from 'three';
import {
  VRM,
  VRMExpressionPresetName,
  VRMHumanBoneList,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMLookAtBoneApplier,
  VRMLookAtExpressionApplier,
  VRMUtils,
} from '@pixiv/three-vrm';
import type { VRMMeta } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  HUMAN_BONES_VRM1,
  PROJECT_USED_BONES,
  REQUIRED_BONES,
  type LookAtType,
  type VrmCapabilities,
} from './contracts';

/**
 * 契约自检：本仓库的骨骼表必须与 three-vrm 的 VRMHumanBoneList 完全一致。
 * 只在开发期首次加载时跑一次——两份清单漂移是这类项目最典型的静默 bug。
 */
let boneListVerified = false;
function verifyBoneList() {
  if (boneListVerified) return;
  boneListVerified = true;
  const fromContracts: readonly string[] = HUMAN_BONES_VRM1;
  const fromThreeVrm: readonly string[] = [...VRMHumanBoneList].sort();
  const sorted = [...fromContracts].sort();
  const same =
    fromThreeVrm.length === sorted.length && fromThreeVrm.every((n, i) => n === sorted[i]);
  if (!same) {
    console.error(
      '[vrm-character] 骨骼表与 three-vrm 不一致！\n' +
        `  contracts (web/lib/human-bones-vrm1.json): ${sorted.length} 根\n` +
        `  three-vrm (VRMHumanBoneList):              ${fromThreeVrm.length} 根\n` +
        `  仅在 contracts: ${sorted.filter((n) => !fromThreeVrm.includes(n)).join(', ') || '-'}\n` +
        `  仅在 three-vrm: ${fromThreeVrm.filter((n) => !sorted.includes(n)).join(', ') || '-'}`,
    );
  }
  if (process.env.NODE_ENV !== 'production') {
    console.info(
      `[vrm-character] 骨骼表自检：contracts ${sorted.length} 根 / three-vrm ${fromThreeVrm.length} 根 → ${same ? '一致' : '不一致'}`,
    );
  }
}

/** VRM1 与 VRM0 的 meta 字段名不同，在这里归一化；VRM0 只在加载入口做兼容（§七）。 */
function normalizeMeta(meta: VRMMeta | undefined) {
  if (!meta) {
    return {
      metaVersion: null,
      specVersion: null,
      assetName: null,
      authors: [] as string[],
      creditNotation: null,
      licenseUrl: null,
    };
  }
  if (meta.metaVersion === '1') {
    return {
      metaVersion: '1' as const,
      specVersion: '1.0',
      assetName: meta.name ?? null,
      authors: [...meta.authors],
      creditNotation: meta.creditNotation ?? null,
      licenseUrl: meta.licenseUrl ?? null,
    };
  }
  return {
    metaVersion: '0' as const,
    specVersion: '0.x',
    assetName: meta.title ?? null,
    authors: meta.author ? [meta.author] : [],
    creditNotation: null,
    licenseUrl: meta.otherLicenseUrl ?? null,
  };
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export interface LoadedVrm {
  vrm: VRM;
  /** 已加入场景的容器。展示尺度和朝向修正只允许改这个对象，不烘进动作（§七）。 */
  root: THREE.Group;
  capabilities: VrmCapabilities;
  /** 释放 GPU 资源并断开引用。多次加载/卸载不产生持续资源增长（§八 验收 #6）。 */
  dispose(): void;
}

/** 能力探测只需要看这几个字段，不需要完整的 glTF 类型。 */
export interface GltfJsonLike {
  extensions?: {
    VRMC_springBone?: { springs?: unknown[]; colliders?: unknown[] };
  };
}

export interface LoadVrmOptions {
  /** 加载进度回调 */
  onProgress?: (loaded: number, total: number) => void;
  /** 是否执行官方推荐的网格/骨架优化，默认 true */
  optimize?: boolean;
}

/** 读 lookAt 驱动类型。必须实测——不同资产可能是 bone 或 expression（§十 控制权表）。 */
function readLookAtType(vrm: VRM): LookAtType | null {
  const applier = vrm.lookAt?.applier;
  if (!applier) return null;
  if (applier instanceof VRMLookAtExpressionApplier) return 'expression';
  if (applier instanceof VRMLookAtBoneApplier) return 'bone';
  return null;
}

/**
 * 探测 VRM 实例的真实能力。所有字段都来自实测，不做任何假设。
 *
 * 弹簧骨有两个不同口径，必须分开报，不能混用：
 * - `springBoneGroups` = 规范级 VRMC_springBone.springs 条数（只能从 glTF JSON 读到）；
 * - `springBoneJoints` = three-vrm 运行时实际持有的关节数（一组可含多个关节）。
 * 二者本来就不相等，报告时必须写清口径，否则会误判成 bug。
 */
export function probeCapabilities(vrm: VRM, gltfJson?: GltfJsonLike): VrmCapabilities {
  verifyBoneList();

  const present = Object.keys(vrm.humanoid.humanBones ?? {});
  const missingBones = HUMAN_BONES_VRM1.filter((b) => !present.includes(b));

  const head = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
  const hips = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
  const headPos = new THREE.Vector3();
  const hipsPos = new THREE.Vector3();
  head?.getWorldPosition(headPos);
  hips?.getWorldPosition(hipsPos);

  const em = vrm.expressionManager;
  const meta = normalizeMeta(vrm.meta);

  return {
    metaVersion: meta.metaVersion,
    specVersion: meta.specVersion,
    assetName: meta.assetName,
    authors: meta.authors,
    creditNotation: meta.creditNotation,
    licenseUrl: meta.licenseUrl,
    lookAtType: readLookAtType(vrm),
    boneCount: present.length,
    missingBones,
    missingProjectBones: PROJECT_USED_BONES.filter((b) => !present.includes(b)),
    missingRequiredBones: REQUIRED_BONES.filter((b) => !present.includes(b)),
    hasUpperChest: present.includes(VRMHumanBoneName.UpperChest),
    expressionsPreset: Object.keys(em?.presetExpressionMap ?? {}).sort(),
    expressionsCustom: Object.keys(em?.customExpressionMap ?? {}).sort(),
    springBoneGroups: gltfJson?.extensions?.VRMC_springBone?.springs?.length ?? null,
    springBoneJoints: vrm.springBoneManager?.joints.size ?? 0,
    springBoneColliders: vrm.springBoneManager?.colliders.length ?? 0,
    headWorldY: head ? Number(headPos.y.toFixed(4)) : null,
    hipsWorldY: hips ? Number(hipsPos.y.toFixed(4)) : null,
  };
}

/** 项目要用到的表情能力是否齐备（§八 验收 #4）。 */
export function checkExpressionSupport(caps: VrmCapabilities) {
  const want = [
    VRMExpressionPresetName.Aa,
    VRMExpressionPresetName.Blink,
    VRMExpressionPresetName.Happy,
    VRMExpressionPresetName.Sad,
    VRMExpressionPresetName.Surprised,
  ];
  return {
    want,
    present: want.filter((n) => caps.expressionsPreset.includes(n)),
    missing: want.filter((n) => !caps.expressionsPreset.includes(n)),
  };
}

/**
 * 加载 VRM。失败时抛出的 Error 带 `name = 'VrmLoadError'`，便于上层做可见错误态。
 */
export async function loadVrm(url: string, opts: LoadVrmOptions = {}): Promise<LoadedVrm> {
  const { onProgress, optimize = true } = opts;

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>(
    (resolve, reject) => {
      loader.load(url, resolve, (e) => onProgress?.(e.loaded, e.total), (err) => {
        const error = new Error(`VRM 加载失败：${url} —— ${errText(err)}`);
        error.name = 'VrmLoadError';
        reject(error);
      });
    },
  );

  const vrm = (gltf.userData as { vrm?: VRM }).vrm;
  if (!vrm) {
    const error = new Error(
      `该文件不是 VRM（gltf.userData.vrm 为空）：${url}。` +
        '若为 VRM 0.x，需确认 VRMLoaderPlugin 的 v0compat 是否启用。',
    );
    error.name = 'VrmLoadError';
    throw error;
  }

  // 官方推荐流程 + VRM 0.x 朝向兼容（§七：只在加载入口做兼容）
  if (optimize) VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);

  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  vrm.update(0);

  // 展示容器：朝向与缩放修正放这里，不动 vrm.scene 内部（§七）
  const root = new THREE.Group();
  root.name = 'vrm-root';
  root.add(vrm.scene);

  const capabilities = probeCapabilities(vrm, gltf.parser.json as GltfJsonLike);
  if (capabilities.missingRequiredBones.length > 0) {
    console.error(
      `[vrm-character] 资产缺少 VRM 1.0 必需骨骼：${capabilities.missingRequiredBones.join(', ')}`,
    );
  }

  return {
    vrm,
    root,
    capabilities,
    dispose() {
      root.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    },
  };
}

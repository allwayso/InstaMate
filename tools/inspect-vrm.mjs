#!/usr/bin/env node
// 能力探测 CLI：读 .vrm(glb) 的 JSON chunk，输出人形骨骼 / 表情 / 弹簧骨 / lookAt 类型。
// 产物必须与 assets/vrm/*.manifest.json 一致——manifest 就是用它生成的。
//
// 用法:
//   node tools/inspect-vrm.mjs web/public/avatars/sample.vrm
//   node tools/inspect-vrm.mjs web/public/avatars/sample.vrm --json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_BONES = JSON.parse(
  readFileSync(resolve(HERE, '../web/lib/human-bones-vrm1.json'), 'utf8'),
);

function parseGlb(buf) {
  if (buf.length < 12) throw new Error('文件太小，不是 GLB');
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'glTF') throw new Error(`魔数不是 glTF：${JSON.stringify(magic)}`);
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null;
  const chunkTypes = [];
  while (off + 8 <= total) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8).replace(/\0/g, '').trim();
    chunkTypes.push(type);
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
    off += 8 + len;
  }
  if (!json) throw new Error('GLB 里没有 JSON chunk');
  return { version, total, json, chunkTypes };
}

// ---- 最小 mat4 工具：只为量出 humanoid 骨骼的世界高度（相机取景用） ----
function composeTRS(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function boneWorldY(json, nodeIndex) {
  const parent = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  const chain = [];
  for (let i = nodeIndex; i !== -1; i = parent[i]) chain.unshift(i);
  let m = composeTRS();
  for (const i of chain) {
    const n = json.nodes[i];
    m = mul(m, n.matrix ? n.matrix : composeTRS(n.translation, n.rotation, n.scale));
  }
  return m[13]; // translation.y
}

function inspect(file) {
  const buf = readFileSync(file);
  const { version, total, json, chunkTypes } = parseGlb(buf);
  const ext = json.extensions ?? {};
  const vrm = ext.VRMC_vrm;
  if (!vrm) throw new Error('不是 VRM：缺少 VRMC_vrm 扩展（可能是 VRM 0.x，本工具只读 VRM 1.0）');

  const bones = Object.keys(vrm.humanoid?.humanBones ?? {});
  const missing = SPEC_BONES.filter((b) => !bones.includes(b));
  const preset = Object.keys(vrm.expressions?.preset ?? {});
  const custom = Object.keys(vrm.expressions?.custom ?? {});
  const spring = ext.VRMC_springBone ?? {};

  const boneNode = (name) => vrm.humanoid?.humanBones?.[name]?.node;
  const hipsIdx = boneNode('hips');
  const headIdx = boneNode('head');

  return {
    file,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    glbVersion: version,
    declaredLength: total,
    chunkTypes,
    extensionsUsed: json.extensionsUsed ?? [],
    specVersion: vrm.specVersion,
    boneCount: bones.length,
    specBoneCount: SPEC_BONES.length,
    missingBones: missing,
    expressionPresetCount: preset.length,
    expressionPresets: [...preset].sort(),
    expressionCustomCount: custom.length,
    expressionCustom: [...custom].sort(),
    springCount: (spring.springs ?? []).length,
    colliderCount: (spring.colliders ?? []).length,
    meshCount: (json.meshes ?? []).length,
    materialCount: (json.materials ?? []).length,
    nodeCount: (json.nodes ?? []).length,
    lookAtType: vrm.lookAt?.type ?? null,
    rig: {
      hipsWorldY:
        typeof hipsIdx === 'number' ? Number(boneWorldY(json, hipsIdx).toFixed(4)) : null,
      headWorldY:
        typeof headIdx === 'number' ? Number(boneWorldY(json, headIdx).toFixed(4)) : null,
    },
    meta: vrm.meta ?? null,
  };
}

// 由探测结果生成 manifest——保证 manifest 永远不能与实测漂移
function toManifest(r, { generatedAt, source }) {
  return {
    asset: r.file.split(/[\\/]/).pop(),
    purpose: 'engineering-sample',
    sha256: r.sha256,
    bytes: r.bytes,
    source,
    generatedAt,
    vrm: {
      specVersion: r.specVersion,
      exporter: null,
      exporterNote: 'GLB asset.generator 为空，导出器版本未声明',
      glTfVersion: r.glbVersion,
      extensionsUsed: r.extensionsUsed,
    },
    rig: {
      boneCount: r.boneCount,
      specBoneCount: r.specBoneCount,
      missingBones: r.missingBones,
      hipsWorldY: r.rig.hipsWorldY,
      headWorldY: r.rig.headWorldY,
      heightM: null,
      heightNote:
        '身高需在 G0 用整模型 bounding box 实测（含头发网格）；此处 hipsWorldY/headWorldY 为骨骼基准值，供相机取景用',
    },
    capabilities: {
      expressionsPreset: r.expressionPresets,
      expressionsPresetCount: r.expressionPresetCount,
      expressionsCustom: r.expressionCustom,
      springBoneGroups: r.springCount,
      springBoneColliders: r.colliderCount,
      lookAtType: r.lookAtType,
      meshes: r.meshCount,
      materials: r.materialCount,
      nodes: r.nodeCount,
    },
    license: {
      licenseUrl: r.meta?.licenseUrl ?? null,
      creditNotation: r.meta?.creditNotation ?? null,
      copyrightInformation: r.meta?.copyrightInformation ?? null,
      authors: r.meta?.authors ?? [],
      avatarPermission: r.meta?.avatarPermission ?? null,
      commercialUsage: r.meta?.commercialUsage ?? null,
      allowRedistribution: r.meta?.allowRedistribution ?? null,
      modification: r.meta?.modification ?? null,
      obligation: 'creditNotation=required —— 演示材料出现该角色必须署名 VirtualCast, Inc.',
    },
    knownIssues: [
      '无 upperChest：脊柱链为 hips→spine→chest→neck→head 共 5 段，相关代码路径必须判空',
      '无 leftEye/rightEye/jaw：lookAt 只能走 expression 型，眼球不由骨骼驱动',
      'lookAt.type=expression：lookAtType 必须由运行时能力探测读取，禁止在代码里写死',
      '本资产仅供工程验证（G0/G1/G2），不是最终演示角色；正式角色是 companion.vrm',
      '自带一个名为 robo_arm 的道具网格（独立根节点，不挂在人形骨架下）——它在所有姿态里都不动，' +
        '不是骨骼变形失败。人工验收"网格随骨骼变形"时应忽略它',
    ],
  };
}

function report(r) {
  const L = (k, v) => console.log(`${k.padEnd(24)}${v}`);
  L('file', r.file);
  L('size', `${r.bytes.toLocaleString('en-US')} B`);
  L('sha256', r.sha256);
  L('glTF version', `${r.glbVersion}  (chunks: ${r.chunkTypes.join(', ')})`);
  L('specVersion', r.specVersion);
  L('extensionsUsed', r.extensionsUsed.join(', '));
  L('humanoid bones', `${r.boneCount}   (VRM1 规范 ${r.specBoneCount})`);
  L('  missing', r.missingBones.length ? `${r.missingBones.join(', ')}` : '(none)');
  L('expressions preset', `${r.expressionPresetCount}`);
  L('  ', r.expressionPresets.join(' '));
  L('expressions custom', `${r.expressionCustomCount}${r.expressionCustom.length ? ' ' + r.expressionCustom.join(', ') : ''}`);
  L('springBone', `${r.springCount} springs, ${r.colliderCount} colliders`);
  L('mesh / material / node', `${r.meshCount} / ${r.materialCount} / ${r.nodeCount}`);
  L('lookAt.type', r.lookAtType ?? '(none)');
  L('rig.hipsWorldY', r.rig.hipsWorldY);
  L('rig.headWorldY', r.rig.headWorldY);
  if (r.meta) {
    L('meta.name', r.meta.name);
    L('meta.authors', (r.meta.authors ?? []).join(', '));
    L('meta.creditNotation', r.meta.creditNotation);
    L('meta.copyright', r.meta.copyrightInformation);
    L('meta.licenseUrl', r.meta.licenseUrl);
  }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const asManifest = args.includes('--manifest');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法: node tools/inspect-vrm.mjs <file.vrm> [--json|--manifest]');
  process.exit(2);
}

try {
  const r = inspect(file);
  if (asManifest) {
    console.log(
      JSON.stringify(
        toManifest(r, {
          generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          source: 'https://github.com/vrm-c/vrm-specification (samples/Seed-san/vrm/Seed-san.vrm)',
        }),
        null,
        2,
      ),
    );
  } else if (asJson) console.log(JSON.stringify(r, null, 2));
  else report(r);
} catch (e) {
  console.error(`无法解析 ${file}: ${e.message}`);
  process.exit(2);
}

#!/usr/bin/env node
/**
 * GLB → VRM 1.0 转换器
 *
 * 为什么需要它：
 *   Tripo / Mixamo 之类的管线产出的是普通 glTF（GLB），而本项目的角色运行层只吃 VRM。
 *   `CharacterRuntime` 只写 **normalized 骨骼**，而那套骨架是 VRM 规范特有的 ——
 *   three-vrm 在加载时按 `VRMC_vrm.humanoid` 的映射现搭出来。没有该扩展就没有它。
 *
 * **一条硬约束，决定了整个转换的形态：**
 *   我们的 clip 格式是 space=normalized-local / rotationMode=absolute，即
 *   "相对 rest pose 的绝对旋转"。而 normalized 骨骼的 rest rotation 恒为单位四元数、
 *   所有骨骼共享 rig 根的坐标系 —— 于是 **"同一个四元数落在身体的哪个方向"完全由
 *   rest pose 决定**。我们的轴线约定是在 Seed-san（VRM 1.0、面朝 +Z、T-pose 手臂沿 ±X）
 *   上实测的，所以目标模型必须在**自己的模型空间里**面朝 +Z、双臂沿 X。
 *
 *   ⚠️ 不能靠"给根节点加旋转"糊弄：给根加旋转会让 normalized rig 的坐标系跟着一起转，
 *   clip 的轴与身体的相对关系不变 —— 抬臂仍然会变成扭臂。必须烘进模型数据本身。
 *
 * 烘的做法（三者必须配合，缺一蒙皮就错）：
 *      设 M = 缩放(s) ∘ 绕Y旋转(θ)
 *      ① 顶点位置：      p' = M · p        （并重算 accessor 的 min/max）
 *      ② 顶点法线：      n' = R · n        （只转不缩，再归一化）
 *      ③ 骨架根节点 local：local' = M · local
 *      ④ inverseBindMatrices：IBM' = IBM · M⁻¹
 *
 *   推导（skin 的顶点最终世界位置 = Σ w · jointWorld · IBM · p）：
 *      Σ w · (M·J) · (IBM·M⁻¹) · (M·p) = M · Σ w · J · IBM · p   ✅ 整体恰被 M 变换
 *
 *   "只转骨架根"是安全的，因为骨架根与 mesh 节点是**兄弟**（Tripo 的实际结构就是如此）。
 *   额外好处：mesh 节点 world 不含 M，所以 Box3.setFromObject（相机取景/视锥剔除）
 *   读到的是烘过的几何包围盒 —— 包围盒也是对的。
 *
 * 用法:
 *   node tools/gltf-to-vrm.mjs <in.glb> -o <out.vrm> [选项]
 *     --name <str>           VRM meta.name（默认取输入文件名）
 *     --authors <a,b>        VRM meta.authors（默认 InstaMate）
 *     --height <m>           目标身高（米），默认 1.75；0 = 不缩放
 *     --rotate <deg|auto>    绕 Y 旋转角度，默认 auto（按左右轴自动把正面转到 +Z）
 *     --dry-run              只报告，不写文件
 *     --json                 末尾附机器可读的检测结果
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 依赖装在 web/node_modules，而本文件在 tools/。
// Node 的 ESM 裸导入按【文件位置】解析、不是 cwd，所以必须走绝对 URL；
// 且必须落在与 package.json exports 相同的文件（否则会加载出两个模块实例）。
const NM = new URL('../web/node_modules/', import.meta.url);
const THREE = await import(new URL('three/build/three.module.js', NM).href);

const HERE = dirname(fileURLToPath(import.meta.url));
/** VRM 1.0 规范骨骼表 —— 唯一真相源，禁止在本文件复制第二份。 */
const SPEC_BONES = JSON.parse(
  readFileSync(resolve(HERE, '../web/lib/human-bones-vrm1.json'), 'utf8'),
);

// ============================================================
// 骨骼映射：Mixamo → VRM 1.0 规范名（22 根）
// ============================================================
//
// 躯干链一一对齐，所以三条脊柱骨各自落到 spine / chest / upperChest：
//   Mixamo:  Hips → Spine → Spine1 → Spine2 → Neck → Head
//   VRM 1.0: hips → spine →  chest  → upperChest → neck → head
//
// 22 根填满 VRM 55 槽位里的 54 个（唯一填不上的是 Mixamo 没有更细的胸椎分段）。
// `Root` 不映射 —— VRM 没有根骨名；它作为 hips 的非人形祖先保留，
// three-vrm 的 normalized rig 会把它的变换吸收进 hips 的位置。
const MIXAMO_TO_VRM = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Neck: 'neck',
  Head: 'head',

  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',

  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes',
};

/** VRM 1.0 的 15 根必需骨骼（VRMRequiredHumanBoneName）。缺一根加载器就会报错。 */
const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
];

/**
 * 归一化节点名：吃掉各种导出器加的前缀与分隔符。
 * 三种写法都见过：`mixamorig:Hips`（glTF 保留冒号）/ `mixamorig_Hips` / `mixamorigHips`（FBXLoader 会吃掉冒号）。
 */
function normalizeBoneName(raw) {
  return String(raw ?? '')
    .replace(/^mixamorig[:_\s-]*/i, '')
    .replace(/[:_\s-]/g, '');
}

// ============================================================
// GLB 读写
// ============================================================

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

function readGlb(buf) {
  if (buf.length < 12) throw new Error('文件太小，不是 GLB');
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('不是 GLB（魔数不对）');
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  if (total !== buf.length) {
    throw new Error(`GLB 声明长度 ${total} 与实际 ${buf.length} 不一致`);
  }

  let off = 12;
  let json = null;
  let bin = null;
  const chunks = [];
  while (off + 8 <= total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) {
      chunks.push('JSON');
      json = JSON.parse(body.toString('utf8'));
    } else if (type === CHUNK_BIN) {
      chunks.push('BIN');
      bin = Buffer.from(body); // 拷一份，下面要原地改
    } else {
      chunks.push(type.toString(16));
    }
    off += 8 + len;
  }
  if (!json) throw new Error('GLB 里没有 JSON chunk');
  if (!bin) throw new Error('GLB 里没有 BIN chunk');
  return { version, json, bin, chunks };
}

function writeGlb(json, bin, outPath) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // JSON 用空格补齐
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(GLB_MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);

  const jHead = Buffer.alloc(8);
  jHead.writeUInt32LE(jsonChunk.length, 0);
  jHead.writeUInt32LE(CHUNK_JSON, 4);

  const bHead = Buffer.alloc(8);
  bHead.writeUInt32LE(binChunk.length, 0);
  bHead.writeUInt32LE(CHUNK_BIN, 4);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.concat([head, jHead, jsonChunk, bHead, binChunk]));
  return total;
}

// ============================================================
// accessor 原地改写（本项目遇到的都是 float32 非交错布局）
// ============================================================

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorLayout(json, index) {
  const a = json.accessors[index];
  const bv = json.bufferViews[a.bufferView];
  const comps = COMPONENTS[a.type];
  if (!comps) throw new Error(`accessor[${index}] 的类型 ${a.type} 不支持`);
  if (a.componentType !== 5126) {
    throw new Error(`accessor[${index}] 不是 float32，本工具暂不支持原地改写`);
  }
  if (bv.byteStride) {
    throw new Error(`accessor[${index}] 是交错布局（byteStride=${bv.byteStride}），本工具暂不支持`);
  }
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return { a, bv, comps, start };
}

function forEachVec3(bin, json, index, fn) {
  const { a, comps, start } = accessorLayout(json, index);
  const v = new THREE.Vector3();
  for (let i = 0; i < a.count; i++) {
    const o = start + i * comps * 4;
    v.set(bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8));
    fn(v, i);
    bin.writeFloatLE(v.x, o);
    bin.writeFloatLE(v.y, o + 4);
    bin.writeFloatLE(v.z, o + 8);
  }
}

// ============================================================
// 节点变换
// ============================================================

function readNodeLocal(n) {
  if (n.matrix) return new THREE.Matrix4().fromArray(n.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
  );
}

function writeNodeLocal(n, m) {
  const t = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(t, q, s);
  delete n.matrix; // glTF 规定 matrix 与 TRS 不可并存
  n.translation = t.toArray();
  n.rotation = q.toArray();
  n.scale = s.toArray();
}

/** 每个节点的父节点索引（-1 表示根）。 */
function buildParentMap(json) {
  const parent = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  return parent;
}

function worldMatrixOf(json, parent, nodeIndex) {
  const chain = [];
  for (let i = nodeIndex; i !== -1; i = parent[i]) chain.unshift(i);
  const m = new THREE.Matrix4();
  for (const i of chain) m.multiply(readNodeLocal(json.nodes[i]));
  return m;
}

// ============================================================
// 朝向判定
// ============================================================
//
// VRM 规范：模型面朝 +Z。在右手 Y-up 系里，面朝 +Z 的角色其【右侧】是 −X
// （right = forward × up = (0,0,1)×(0,1,0) = (−1,0,0)）。
// 这与本项目 `RIG_AXIS_CONVENTION.characterRightAxis = '-X'` 一致。
//
// 所以"把角色转正"= 把它的【左右轴】转到 −X。
//
// 左右轴用哪根骨量？**用最长的那个** —— 信噪比最高：
//   肩线（RightArm − LeftArm）在 T-pose 下是最长的水平基线；
//   髋线（RightUpLeg − LeftUpLeg）短一半，相对噪声更大。
// 实测该模型：肩线 0.2753 / 髋线 0.1308，两者估计相差约 6°；
// 肩线的估计与"双脚平均的脚趾朝向"一致，故取肩线。
// 脚趾方向只作【对照】打印，不参与决策 —— 人站立时脚常外八，单脚更甚。
function lateralToRotateDeg(L) {
  // 在 (x,z) 平面里，绕 Y 转 θ 等价于标准 2D 旋转 −θ。
  // 要把方向 L 转到目标 φ_target（−X 即 180°）：θ = φ_L − φ_target
  return (Math.atan2(L.z, L.x) * 180) / Math.PI - 180;
}
function toeToRotateDeg(f) {
  // 脚趾指向"前"，要把它转到 +Z
  return (Math.atan2(-f.x, f.z) * 180) / Math.PI;
}

// ============================================================
// 参数
// ============================================================

function parseArgs(argv) {
  const o = {
    input: null, output: null, name: null, authors: ['InstaMate'],
    height: 1.75, rotate: 'auto', dryRun: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.output = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--authors') o.authors = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--height') o.height = Number(argv[++i]);
    else if (a === '--rotate') o.rotate = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`未知参数 ${a}`);
    else o.input = a;
  }
  if (!o.input) throw new Error('缺少输入文件。用法: node tools/gltf-to-vrm.mjs <in.glb> -o <out.vrm>');
  return o;
}

// ============================================================
// 主流程
// ============================================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inPath = resolve(args.input);
  const outPath = resolve(
    args.output ?? inPath.replace(/\.glb$/i, '').replace(/\.vrm$/i, '') + '.vrm',
  );

  console.log('='.repeat(70));
  console.log('GLB → VRM 1.0');
  console.log('='.repeat(70));
  console.log(`  输入：${inPath}`);
  console.log(`  输出：${outPath}`);

  const { version, json, bin } = readGlb(readFileSync(inPath));
  console.log(
    `  GLB v${version}   nodes ${json.nodes.length}  meshes ${(json.meshes ?? []).length}  ` +
      `skins ${(json.skins ?? []).length}`,
  );

  if (!json.skins?.length) {
    throw new Error('输入没有 skin —— 静态网格无法转 VRM（需要先绑骨）');
  }
  if ((json.meshes ?? []).length !== 1) {
    throw new Error(`本工具目前只处理单网格资产，输入有 ${json.meshes.length} 个 mesh`);
  }
  const skin = json.skins[0];
  const prim = json.meshes[0].primitives[0];

  // ---------- Step 1：骨架与映射 ----------
  const byName = new Map();
  json.nodes.forEach((n, i) => {
    if (!n.name) return;
    const key = normalizeBoneName(n.name).toLowerCase();
    if (!byName.has(key)) byName.set(key, i);
  });

  const humanBones = {};
  const unmapped = [];
  for (const [mixamo, vrm] of Object.entries(MIXAMO_TO_VRM)) {
    const idx = byName.get(mixamo.toLowerCase());
    if (idx === undefined) unmapped.push(`${mixamo} → ${vrm}`);
    else humanBones[vrm] = { node: idx };
  }

  console.log('\n  --- 骨骼映射 ---');
  console.log(`    映射成功 ${Object.keys(humanBones).length} / ${Object.keys(MIXAMO_TO_VRM).length} 根`);
  if (unmapped.length) {
    console.log(`    ⚠️ 未找到 ${unmapped.length} 根（这些 VRM 槽位留空，属"模型天然没有"）：`);
    for (const u of unmapped) console.log(`        ${u}`);
  }

  const missingRequired = REQUIRED_BONES.filter((b) => !(b in humanBones));
  if (missingRequired.length) {
    throw new Error(
      `缺少 VRM 1.0 必需骨骼，加载器会拒绝：${missingRequired.join(', ')}\n` +
        `  输入里的节点名：${json.nodes.map((n) => n.name).filter(Boolean).join(', ')}`,
    );
  }
  console.log(`    ✅ VRM 1.0 的 ${REQUIRED_BONES.length} 根必需骨骼齐全`);

  const notInSpec = Object.keys(humanBones).filter((b) => !SPEC_BONES.includes(b));
  if (notInSpec.length) {
    throw new Error(`映射出了不在 VRM 规范里的骨骼名：${notInSpec.join(', ')} —— 映射表写错了`);
  }

  // ---------- Step 2：自动判定朝向与尺度 ----------
  const parent = buildParentMap(json);
  const worldPos = (i) => new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(json, parent, i));

  const posAccessor = json.accessors[prim.attributes.POSITION];
  const srcBox = new THREE.Box3(
    new THREE.Vector3(...posAccessor.min),
    new THREE.Vector3(...posAccessor.max),
  );
  const srcHeight = srcBox.max.y - srcBox.min.y;

  const lateralOf = (rName, lName) => {
    const r = humanBones[rName]?.node;
    const l = humanBones[lName]?.node;
    if (r === undefined || l === undefined) return null;
    const v = worldPos(r).sub(worldPos(l));
    v.y = 0;
    return v.lengthSq() > 1e-12 ? v : null;
  };

  const laterals = [
    { name: '肩线 RightArm-LeftArm', vec: lateralOf('rightUpperArm', 'leftUpperArm') },
    { name: '髋线 RightUpLeg-LeftUpLeg', vec: lateralOf('rightUpperLeg', 'leftUpperLeg') },
  ].filter((x) => x.vec);

  const toeVecs = [];
  for (const [f, t] of [['leftFoot', 'leftToes'], ['rightFoot', 'rightToes']]) {
    const fi = humanBones[f]?.node;
    const ti = humanBones[t]?.node;
    if (fi === undefined || ti === undefined) continue;
    const v = worldPos(ti).sub(worldPos(fi));
    v.y = 0;
    if (v.lengthSq() > 1e-12) toeVecs.push(v);
  }
  const toeAvg = toeVecs.length
    ? toeVecs.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(toeVecs.length)
    : null;

  let rotateDeg;
  let rotateSource;
  if (args.rotate !== 'auto') {
    rotateDeg = Number(args.rotate);
    if (!Number.isFinite(rotateDeg)) throw new Error(`--rotate 不是合法角度：${args.rotate}`);
    rotateSource = '命令行指定';
  } else if (laterals.length) {
    const best = laterals.reduce((a, b) => (a.vec.lengthSq() >= b.vec.lengthSq() ? a : b));
    rotateDeg = lateralToRotateDeg(best.vec);
    rotateSource = best.name;
  } else if (toeAvg) {
    rotateDeg = toeToRotateDeg(toeAvg); // 退化路径：骨骼不全，只能靠脚趾
    rotateSource = '脚趾（退化路径）';
  } else {
    throw new Error('既无肩/髋线也无脚趾骨，无法判定朝向，请用 --rotate <deg> 显式指定');
  }

  const scale = args.height > 0 ? args.height / srcHeight : 1;
  const rad = (rotateDeg * Math.PI) / 180;

  console.log('\n  --- 朝向与尺度 ---');
  console.log('    左右轴候选（水平；基线越长信噪比越高）：');
  for (const c of laterals) {
    const deg = (Math.atan2(c.vec.z, c.vec.x) * 180) / Math.PI;
    console.log(
      `      ${c.name.padEnd(28)} 长 ${c.vec.length().toFixed(4)}  ` +
        `方位 ${deg.toFixed(2).padStart(7)}°  → 需转 ${lateralToRotateDeg(c.vec).toFixed(2).padStart(7)}°`,
    );
  }
  if (toeAvg) {
    console.log(
      `      ${'脚趾（双脚均值，仅对照）'.padEnd(28)} 长 ${toeAvg.length().toFixed(4)}  ` +
        `方位 ${((Math.atan2(toeAvg.z, toeAvg.x) * 180) / Math.PI).toFixed(2).padStart(7)}°  ` +
        `→ 需转 ${toeToRotateDeg(toeAvg).toFixed(2).padStart(7)}°`,
    );
  }
  console.log(`    ⇨ 采用【${rotateSource}】：绕 Y 旋转 ${rotateDeg.toFixed(2)}°`);
  console.log(`    网格高（原始）  ${srcHeight.toFixed(4)}`);
  console.log(
    `    缩放            ×${scale.toFixed(4)}  → 目标身高 ${args.height > 0 ? `${args.height} m` : '(不缩放)'}`,
  );

  const M = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad),
    new THREE.Vector3(scale, scale, scale),
  );
  const Minv = M.clone().invert();
  const Ronly = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(rad));

  const detect = {
    input: inPath,
    output: outPath,
    srcHeight: +srcHeight.toFixed(6),
    rotateDeg: +rotateDeg.toFixed(4),
    rotateSource,
    lateralCandidates: laterals.map((c) => ({
      name: c.name,
      length: +c.vec.length().toFixed(6),
      rotateDeg: +lateralToRotateDeg(c.vec).toFixed(4),
    })),
    toeRotateDeg: toeAvg ? +toeToRotateDeg(toeAvg).toFixed(4) : null,
    scale: +scale.toFixed(6),
    mappedBones: Object.keys(humanBones).length,
    unmapped,
  };

  if (args.dryRun) {
    console.log('\n  （--dry-run：不写文件）');
    if (args.json) console.log('\n--- JSON ---\n' + JSON.stringify(detect, null, 2));
    return 0;
  }

  // ---------- Step 3：烘数据 ----------
  console.log('\n  --- 烘数据 ---');

  // ① 顶点位置（顺带重算包围盒）
  const newBox = new THREE.Box3();
  forEachVec3(bin, json, prim.attributes.POSITION, (v) => {
    v.applyMatrix4(M);
    newBox.expandByPoint(v);
  });
  posAccessor.min = newBox.min.toArray();
  posAccessor.max = newBox.max.toArray();
  const newSize = newBox.getSize(new THREE.Vector3());
  console.log(
    `    ① POSITION  ${posAccessor.count.toLocaleString('en-US')} 个    ` +
      `新包围盒 ${newSize.toArray().map((x) => x.toFixed(3)).join(' × ')}`,
  );

  // ② 顶点法线（只转不缩）
  if (prim.attributes.NORMAL !== undefined) {
    forEachVec3(bin, json, prim.attributes.NORMAL, (n) => n.applyMatrix3(Ronly).normalize());
    console.log(
      `    ② NORMAL    ${json.accessors[prim.attributes.NORMAL].count.toLocaleString('en-US')} 个（只旋转不缩放）`,
    );
  }

  // ③ 骨架根节点（骨架根是 mesh 节点的兄弟 → 只转骨架）
  const jointSet = new Set(skin.joints);
  const skinRoots = skin.joints.filter((j) => !jointSet.has(parent[j]));
  console.log(
    `    ③ 骨架根节点 ${skinRoots.length} 个：${skinRoots.map((i) => json.nodes[i].name ?? i).join(', ')}`,
  );
  for (const rj of skinRoots) {
    writeNodeLocal(json.nodes[rj], M.clone().multiply(readNodeLocal(json.nodes[rj])));
  }

  // ④ inverseBindMatrices：IBM' = IBM · M⁻¹
  const ibmIndex = skin.inverseBindMatrices;
  const { start: ibmStart } = accessorLayout(json, ibmIndex);
  const ibmCount = json.accessors[ibmIndex].count;
  for (let i = 0; i < ibmCount; i++) {
    const o = ibmStart + i * 64;
    const arr = new Array(16);
    for (let k = 0; k < 16; k++) arr[k] = bin.readFloatLE(o + k * 4);
    const out = new THREE.Matrix4().fromArray(arr).multiply(Minv).toArray();
    for (let k = 0; k < 16; k++) bin.writeFloatLE(out[k], o + k * 4);
  }
  console.log(`    ④ IBM       ${ibmCount} 个矩阵乘以 M⁻¹`);

  // ---------- Step 4：注入 VRMC_vrm ----------
  const meta = {
    name: args.name ?? basename(inPath, extname(inPath)),
    version: '1.0',
    authors: args.authors,
    copyrightInformation: '',
    contactInformation: '',
    references: [],
    thirdPartyLicenses: '由 InstaMate tools/gltf-to-vrm.mjs 从 glTF 资产转换而来',
    licenseUrl: 'https://vrm.dev/licenses/1.0/',
    avatarPermission: 'everyone',
    allowExcessivelyViolentUsage: false,
    allowExcessivelySexualUsage: false,
    commercialUsage: 'personalNonProfit',
    allowPoliticalOrReligiousUsage: false,
    allowAntisocialOrHateUsage: false,
    creditNotation: 'unnecessary',
    allowRedistribution: false,
    modification: 'prohibited',
  };
  // VRM 规范不允许 null/undefined 值：把空键删掉而不是留 undefined
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];

  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'VRMC_vrm'])];
  json.extensions = {
    ...(json.extensions ?? {}),
    VRMC_vrm: { specVersion: '1.0', meta, humanoid: { humanBones } },
  };
  json.asset = json.asset ?? {};
  json.asset.generator = 'InstaMate tools/gltf-to-vrm.mjs';
  console.log('\n  --- 注入 ---');
  console.log(`    extensionsUsed  ${json.extensionsUsed.join(', ')}`);
  console.log(
    `    VRMC_vrm        specVersion ${json.extensions.VRMC_vrm.specVersion}，humanBones ${Object.keys(humanBones).length} 根`,
  );

  // ---------- 写文件 ----------
  const bytes = writeGlb(json, bin, outPath);
  console.log(`\n    已写出 ${outPath}  ${(bytes / 1048576).toFixed(2)} MB`);

  // ---------- Step 5：自检（重新解析产物，不复述内存状态） ----------
  const check = selfCheck(outPath, args.height);
  const ok = check.problems.length === 0;

  console.log('\n' + '='.repeat(70));
  console.log(ok ? '自检通过 ✅' : '自检失败 ❌');
  console.log('='.repeat(70));
  const L = (k, v) => console.log(`  ${String(k).padEnd(22)}${v}`);
  L('humanBones', `${check.boneCount} 根（VRM1 规范 ${SPEC_BONES.length}）`);
  L('missing（天然没有）', check.missingBones.length ? check.missingBones.join(', ') : '(无)');
  L('unknown（不该有）', check.unknownBones.length ? check.unknownBones.join(', ') : '(无)');
  L('15 根必需骨骼', check.requiredOk ? '齐全 ✅' : `缺 ${check.missingRequired.join(', ')} ❌`);
  L('左右轴（新）', check.lateral ? check.lateral.map((x) => x.toFixed(4)).join(', ') : '(无)');
  L('  偏差', check.lateralDeviationDeg === null ? '(无)' : `${check.lateralDeviationDeg.toFixed(2)}°（要求 < 10°）`);
  L('脚趾方向（新，对照）', check.toeDir ? check.toeDir.map((x) => x.toFixed(4)).join(', ') : '(无)');
  L('  与 +Z 夹角', check.toeDeviationDeg === null ? '(无)' : `${check.toeDeviationDeg.toFixed(1)}°`);
  L('身高', `${check.height.toFixed(4)} m ${check.heightOk ? '✅' : '❌'}`);
  for (const p of check.problems) console.log(`  ❌ ${p}`);

  if (args.json) {
    console.log('\n--- JSON ---');
    console.log(JSON.stringify({ ...detect, ...check, ok }, null, 2));
  }
  return ok ? 0 : 1;
}

// ============================================================
// 自检：重新解析产物
// ============================================================

function selfCheck(file, targetHeight) {
  const { json } = readGlb(readFileSync(file));
  const vrm = json.extensions?.VRMC_vrm;
  const problems = [];

  if (!vrm) throw new Error('自检失败：产物里没有 VRMC_vrm');
  if (!json.extensionsUsed?.includes('VRMC_vrm')) problems.push('extensionsUsed 里没有 VRMC_vrm');

  const bones = Object.keys(vrm.humanoid?.humanBones ?? {});
  const missingBones = SPEC_BONES.filter((b) => !bones.includes(b));
  const unknownBones = bones.filter((b) => !SPEC_BONES.includes(b));
  if (unknownBones.length) problems.push(`出现不在规范里的骨骼名：${unknownBones.join(', ')}`);

  const missingRequired = REQUIRED_BONES.filter((b) => !bones.includes(b));
  if (missingRequired.length) problems.push(`缺必需骨骼：${missingRequired.join(', ')}`);

  // 从【烘过的数据】重新量 —— 这是"验证"而不是"复述"
  const parent = buildParentMap(json);
  const worldPos = (i) => new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(json, parent, i));
  const nodeOf = (b) => vrm.humanoid.humanBones[b]?.node;

  // 左右轴：应当落在 −X 上（面朝 +Z 的角色右侧是 −X）
  const rArm = nodeOf('rightUpperArm');
  const lArm = nodeOf('leftUpperArm');
  let lateral = null;
  let lateralDeviationDeg = null;
  if (rArm !== undefined && lArm !== undefined) {
    const v = worldPos(rArm).sub(worldPos(lArm));
    v.y = 0;
    if (v.lengthSq() > 1e-12) {
      lateral = v.clone().normalize().toArray().map((x) => +x.toFixed(6));
      // 与 −X 的夹角
      const cos = v.clone().normalize().dot(new THREE.Vector3(-1, 0, 0));
      lateralDeviationDeg = +(Math.acos(Math.min(1, Math.max(-1, cos))) * (180 / Math.PI)).toFixed(4);
      if (lateralDeviationDeg > 10) {
        problems.push(`左右轴偏离 −X 达 ${lateralDeviationDeg.toFixed(2)}°（> 10°），角色没有正对 +Z`);
      }
    }
  } else {
    problems.push('缺 leftUpperArm / rightUpperArm，无法验证朝向');
  }

  // 脚趾方向：对照用（脚会外八，所以只警告不判失败）
  const fi = nodeOf('leftFoot') ?? nodeOf('rightFoot');
  const ti = nodeOf('leftToes') ?? nodeOf('rightToes');
  let toeDir = null;
  let toeDeviationDeg = null;
  if (fi !== undefined && ti !== undefined) {
    const v = worldPos(ti).sub(worldPos(fi));
    v.y = 0;
    if (v.lengthSq() > 1e-12) {
      toeDir = v.clone().normalize().toArray().map((x) => +x.toFixed(6));
      const cos = v.clone().normalize().dot(new THREE.Vector3(0, 0, 1));
      toeDeviationDeg = +(Math.acos(Math.min(1, Math.max(-1, cos))) * (180 / Math.PI)).toFixed(2);
      if (toeDeviationDeg > 35) {
        problems.push(`脚趾方向偏离 +Z 达 ${toeDeviationDeg.toFixed(1)}° —— 可能整体转错了方向`);
      }
    }
  }

  const prim = json.meshes[0].primitives[0];
  const acc = json.accessors[prim.attributes.POSITION];
  const height = acc.max[1] - acc.min[1];
  const heightOk = targetHeight > 0 ? Math.abs(height - targetHeight) < 0.05 : true;
  if (!heightOk) problems.push(`身高 ${height.toFixed(4)} m 偏离目标 ${targetHeight} m 超过 5cm`);

  return {
    boneCount: bones.length,
    missingBones,
    unknownBones,
    missingRequired,
    requiredOk: missingRequired.length === 0,
    lateral,
    lateralDeviationDeg,
    toeDir,
    toeDeviationDeg,
    height: +height.toFixed(6),
    heightOk,
    problems,
  };
}

// 直接执行时才跑主流程；被 import（测试）时只导出纯函数。
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());

export {
  MIXAMO_TO_VRM,
  REQUIRED_BONES,
  normalizeBoneName,
  lateralToRotateDeg,
  toeToRotateDeg,
  readGlb,
  writeGlb,
  SPEC_BONES,
};

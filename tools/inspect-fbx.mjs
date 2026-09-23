#!/usr/bin/env node
/**
 * FBX 资产检查器（Node 直跑，不用浏览器）
 *
 * 为什么需要它：
 *   Tripo / Mixamo 的绑骨产物都是 FBX，而 FBX 是二进制专有格式，
 *   骨骼层次和 rest pose 只能靠解析器读。three.js 的 FBXLoader 能在 Node 里
 *   用 `parse(ArrayBuffer)` 直接吃文件，省掉开浏览器的麻烦。
 *
 * 最重要的输出是 **rest pose 判定**：
 *   我们的 clip 格式（rotationMode: absolute）在数学上依赖 rest pose==T-pose，
 *   所以任何第三方模型接进来之前，第一件事就是量这个。
 *
 * 用法：
 *   node tools/inspect-fbx.mjs <file.fbx> [--json]
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// 依赖装在 web/node_modules，而本文件在 tools/。
// Node 的 ESM 裸导入('three')是按【文件位置】解析的，不是 cwd，所以必须走绝对 URL。
// 用 URL 直连 build 产物 → 与 package.json exports 的 './build/three.module.js'
// 落到同一个文件 URL，因此与 FBXLoader 内部 import 的是【同一个模块实例】
// （否则 instanceof 检查会静默失效）。
const NM = new URL('../web/node_modules/', import.meta.url);
const THREE = await import(new URL('three/build/three.module.js', NM).href);

// Node 里没有 DOM。Tripo/Mixamo 的 FBX 往往**内嵌贴图**，FBXLoader 会为此去
// document.createElementNS('img') 而直接抛 ReferenceError。我们只关心骨骼与 rest pose，
// 所以把纹理加载整个短路掉（返回空 Texture 对象，不发起任何 IO）。
THREE.TextureLoader.prototype.load = function load() {
  return new THREE.Texture();
};
if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = () => 'blob:stub';
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({
      addEventListener() {},
      removeEventListener() {},
      width: 1,
      height: 1,
      set src(_v) {},
    }),
  };
}

const { FBXLoader } = await import(new URL('three/examples/jsm/loaders/FBXLoader.js', NM).href);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
if (!file) {
  console.error('用法: node tools/inspect-fbx.mjs <file.fbx> [--json]');
  process.exit(1);
}

const path = resolve(file);
const buf = readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const root = new FBXLoader().parse(ab, '');
root.updateMatrixWorld(true);

const V3 = (v) => [+v.x.toFixed(6), +v.y.toFixed(6), +v.z.toFixed(6)];
const info = { file: path, name: basename(path), sizeMB: +(buf.length / 1048576).toFixed(2) };

console.log('='.repeat(68));
console.log(`文件：${info.name}   ${info.sizeMB} MB`);
console.log('='.repeat(68));

// ---------------- 遍历 ----------------
const bones = [];
const skinned = [];
const meshes = [];
let textures = 0;
root.traverse((o) => {
  if (o.isBone) bones.push(o);
  if (o.isSkinnedMesh) skinned.push(o);
  else if (o.isMesh) meshes.push(o);
  const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
  for (const m of mats) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
      if (m[k]) textures++;
    }
  }
});

let tris = 0;
let verts = 0;
for (const m of [...skinned, ...meshes]) {
  const p = m.geometry?.attributes?.position;
  if (p) verts += p.count;
  tris += (m.geometry?.index ? m.geometry.index.count : (p?.count ?? 0)) / 3;
}

console.log(`  骨骼 ${bones.length} | 蒙皮网格 ${skinned.length} | 普通网格 ${meshes.length}`);
console.log(`  顶点 ${verts.toLocaleString()} | 三角面 ${Math.round(tris).toLocaleString()} | 贴图引用 ${textures}`);
console.log(`  动画剪辑 ${root.animations?.length ?? 0}`);
info.bones = bones.length;
info.skinnedMeshes = skinned.length;
info.vertices = verts;
info.triangles = Math.round(tris);
info.textures = textures;
info.animations = root.animations?.length ?? 0;

// ---------------- 包围盒 ----------------
const box = new THREE.Box3();
for (const m of [...skinned, ...meshes]) box.expandByObject(m);
const size = box.getSize(new THREE.Vector3());
console.log(`\n  包围盒尺寸  X${size.x.toFixed(4)}  Y${size.y.toFixed(4)}  Z${size.z.toFixed(4)}`);
info.bbox = { min: V3(box.min), max: V3(box.max), size: V3(size) };

// ---------------- 骨骼名 ----------------
const byName = new Map();
for (const b of bones) byName.set(b.name, b);
const stripped = (n) => n.replace(/^mixamorig[:_\s]*/i, '').replace(/[_\s]/g, '');

const find = (...cands) => {
  for (const c of cands) {
    if (byName.has(c)) return byName.get(c);
    for (const [n, b] of byName) {
      if (stripped(n).toLowerCase() === c.toLowerCase()) return b;
    }
  }
  return null;
};

const prefixes = [...new Set(bones.map((b) => b.name.split(/[:_]/)[0]))];
console.log(`\n  命名前缀：${prefixes.slice(0, 6).join(', ')}`);
if (bones.length <= 90) {
  // 必须用 DFS：按 depth 排序再缩进会把"同层的下一根"印成"上一根的子节点"，
  // 看起来像层级断了（实际层级是好的）。
  console.log('  骨骼层级:');
  const walk = (b, indent) => {
    console.log(`    ${'  '.repeat(indent)}${b.name}`);
    for (const c of b.children) if (c.isBone) walk(c, indent + 1);
  };
  const roots = bones.filter((b) => !b.parent?.isBone);
  for (const r of roots) walk(r, 0);
}
info.boneNames = bones.map((b) => b.name);

// ---------------- ★ rest pose 判定 ----------------
console.log('\n' + '-'.repeat(68));
console.log('  ★ rest pose 判定（clip 契约的数学前提）');
console.log('-'.repeat(68));

const restPose = {};
const P = (b) => (b ? b.getWorldPosition(new THREE.Vector3()) : null);

const lsh = find('LeftArm', 'LeftShoulder', 'LeftUpperArm');
const rsh = find('RightArm', 'RightShoulder', 'RightUpperArm');
const lh = find('LeftHand');
const rh = find('RightHand');
const la = lsh;
const ra = rsh;
const le = find('LeftForeArm', 'LeftLowerArm');
const re = find('RightForeArm', 'RightLowerArm');
const hip = find('Hips');
const head = find('Head');

for (const [k, b] of Object.entries({ lsh, rsh, lh, rh, hip, head })) {
  if (b) restPose[k] = V3(P(b));
}
info.restPose = restPose;

let verdict = '无法判定（缺少标准骨骼名）';
const angles = {};
if (lsh && lh) {
  const a = P(lsh);
  const h = P(lh);
  console.log(`  左肩 y=${a.y.toFixed(4)}   左手 y=${h.y.toFixed(4)}   差 ${Math.abs(h.y - a.y).toFixed(4)}`);
  restPose.leftShoulderY = +a.y.toFixed(6);
  restPose.leftHandY = +h.y.toFixed(6);
}
if (rsh && rh) {
  const a = P(rsh);
  const h = P(rh);
  console.log(`  右肩 y=${a.y.toFixed(4)}   右手 y=${h.y.toFixed(4)}   差 ${Math.abs(h.y - a.y).toFixed(4)}`);
  restPose.rightShoulderY = +a.y.toFixed(6);
  restPose.rightHandY = +h.y.toFixed(6);
}
for (const [tag, a, e] of [['左', la, le], ['右', ra, re]]) {
  if (!a || !e) continue;
  const d = P(e).sub(P(a));
  const len = d.length();
  if (len < 1e-9) continue;
  d.divideScalar(len);
  const ang = (Math.asin(Math.min(1, Math.abs(d.y))) * 180) / Math.PI;
  angles[tag === '左' ? 'leftArmAngleDeg' : 'rightArmAngleDeg'] = +ang.toFixed(2);
  console.log(`  ${tag}上臂与水平面夹角 ${ang.toFixed(2).padStart(6)}°   方向 ${V3(d)}   骨长 ${len.toFixed(4)}`);
}
info.armAngles = angles;

if (lsh && rsh && lh && rh) {
  const span = P(lh).distanceTo(P(rh));
  // ★ 用 Arm（肩关节）而不是 Shoulder：Mixamo 的 Shoulder 骨根在颈根/胸中心，
  // 左右两根相距几毫米，拿它算"肩宽"会得到 0.0003 这种荒谬值。
  const shoulder = P(lsh).distanceTo(P(rsh));
  console.log(`  双手横向跨度 ${span.toFixed(4)}   肩宽 ${shoulder.toFixed(4)}   比值 ${(span / shoulder).toFixed(2)}`);
  info.handSpan = +span.toFixed(6);
  info.shoulderSpan = +shoulder.toFixed(6);

  const midShoulderY = (P(lsh).y + P(rsh).y) / 2;
  const midHandY = (P(lh).y + P(rh).y) / 2;
  const drop = Math.abs(midHandY - midShoulderY);
  // 阈值用【全身高】（用包围盒高度），不是 hips→head 的躯干长。
  const height = size.y || (hip && head ? P(head).y - P(hip).y : 1);
  const maxArmAngle = Math.max(angles.leftArmAngleDeg ?? 0, angles.rightArmAngleDeg ?? 0);
  // ★ 主判据用【上臂与水平面的夹角】：它直接就是 clip 语义里的"手臂基准偏差"。
  // 手比肩低多少只是同一件事的几何表现，两者一致时以角度为准。
  verdict =
    maxArmAngle < 3
      ? 'T-POSE ✅'
      : maxArmAngle < 12
        ? `近似 T-pose ⚠️（上臂最大下斜 ${maxArmAngle.toFixed(1)}°，clip 的手臂基准会偏这几度）`
        : '垂臂 / A-pose ❌';
  console.log(`  手比肩低 ${drop.toFixed(4)}（占身高 ${((drop / height) * 100).toFixed(1)}%）`);
  console.log(`  ⇒ ${verdict}`);
  info.poseVerdict = verdict;
  info.maxArmAngleDeg = +maxArmAngle.toFixed(2);
  info.handDropRatio = +(drop / height).toFixed(4);
}

// ---------------- 尺度 ----------------
console.log('\n' + '-'.repeat(68));
console.log('  尺度');
console.log('-'.repeat(68));
if (hip && head) {
  const dy = P(head).y - P(hip).y;
  console.log(`  hips y=${P(hip).y.toFixed(4)}   head y=${P(head).y.toFixed(4)}   hips→head ${dy.toFixed(4)}`);
}
// ★ 只有包围盒高度能判"单位是不是米"：VRM 规范要求模型以米为单位，成人身高
// 应在 1.4-2.1 之间。Tripo 的产物常被归一化到 ~1 单位，直接当 VRM 用会渲染成
// 一个 1 米高的小人，必须先缩放。
const H = size.y;
const scaleVerdict =
  H >= 1.4 && H <= 2.1
    ? `米制、成人身高 ✅（${H.toFixed(3)} m）`
    : H > 0.4 && H < 1.4
      ? `⚠️ 疑似归一化到 ~1 单位（高 ${H.toFixed(3)}）→ 需缩放 ×${(1.7 / H).toFixed(2)} 才是成人身高`
      : `⚠️ 尺度异常（高 ${H.toFixed(3)}），需人工确认`;
console.log(`  网格高度 ${H.toFixed(4)}`);
console.log(`  ⇒ ${scaleVerdict}`);
info.scaleVerdict = scaleVerdict;
info.meshHeight = +H.toFixed(6);
info.suggestedScale = H >= 1.4 && H <= 2.1 ? 1 : +(1.7 / H).toFixed(4);

// ---------------- 朝向 ----------------
console.log('\n' + '-'.repeat(68));
console.log('  朝向（VRM/Mixamo 要求角色面朝 +Z）');
console.log('-'.repeat(68));
const lfoot = find('LeftFoot');
const ltoe = find('LeftToeBase');
const rfoot = find('RightFoot');
const rtoe = find('RightToeBase');
if (lfoot && ltoe) {
  // ★ 不能只看 z 分量：Tripo 的模型常常面朝 ±X（左右轴=Z、前后轴=X）。
  // 应该取水平分量里绝对值最大的那根轴来判，否则会把 +X 朝向误报成 -Z。
  const d = P(ltoe).sub(P(lfoot));
  const axes = [
    ['+X', d.x],
    ['-X', -d.x],
    ['+Z', d.z],
    ['-Z', -d.z],
  ].sort((a, b) => b[1] - a[1]);
  const facing = axes[0][0];
  console.log(`  左脚 foot→toe 方向 ${V3(d)}   （主导轴 ${facing}）`);
  if (rfoot && rtoe) {
    const d2 = P(rtoe).sub(P(rfoot));
    const f2 = [['+X', d2.x], ['-X', -d2.x], ['+Z', d2.z], ['-Z', -d2.z]].sort((a, b) => b[1] - a[1])[0][0];
    console.log(`  右脚 foot→toe 方向 ${V3(d2)}   （主导轴 ${f2}）`);
  }
  const need = facing === '+Z' ? '✅ 符合规范，无需旋转' : `❌ 需绕 Y 轴旋转把 ${facing} 转成 +Z`;
  console.log(`  ⇒ 角色面朝 ${facing}   ${need}`);
  info.facing = facing;
  info.toeDir = V3(d);
} else {
  console.log('  （无 toe 骨，无法从骨骼判朝向）');
}

if (asJson) {
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(info, null, 2));
}
console.log('='.repeat(68));

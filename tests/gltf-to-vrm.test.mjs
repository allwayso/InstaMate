/**
 * gltf-to-vrm.mjs 的纯逻辑测试。
 *
 * 这个工具的真正风险不在数学（数学是推导出来的、且端到端已验），而在**映射表**：
 * 22 条 Mixamo → VRM 的对应关系是手写的，一旦写错一个字母，产物会在加载时才报错，
 * 而且报错信息离根因很远。所以这里把映射表钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIXAMO_TO_VRM,
  REQUIRED_BONES,
  SPEC_BONES,
  normalizeBoneName,
  lateralToRotateDeg,
  toeToRotateDeg,
} from '../tools/gltf-to-vrm.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------
// 映射表
// ---------------------------------------------------------------

test('映射表只产出 VRM 1.0 规范里的骨骼名', () => {
  const bad = Object.values(MIXAMO_TO_VRM).filter((v) => !SPEC_BONES.includes(v));
  assert.deepEqual(bad, [], `这些目标名不在规范里：${bad.join(', ')}`);
});

test('★ 映射表覆盖 VRM 的 15 根必需骨骼', () => {
  const vals = new Set(Object.values(MIXAMO_TO_VRM));
  const missing = REQUIRED_BONES.filter((r) => !vals.has(r));
  assert.deepEqual(
    missing,
    [],
    `缺必需骨骼会让 three-vrm 直接拒绝加载：${missing.join(', ')}`,
  );
});

test('映射表目标名不重复', () => {
  const vals = Object.values(MIXAMO_TO_VRM);
  assert.equal(new Set(vals).size, vals.length, '同一个 VRM 槽位被映射了两次');
});

test('映射表是 22 根，与 Mixamo 标准骨架一致', () => {
  assert.equal(Object.keys(MIXAMO_TO_VRM).length, 22);
});

test('躯干链一一对齐：Spine→spine, Spine1→chest, Spine2→upperChest', () => {
  // 这三条错位是最容易发生、也最难从现象反推的错误
  // （错了之后表现是"弯腰时上半身不动"之类，离根因很远）
  assert.equal(MIXAMO_TO_VRM.Spine, 'spine');
  assert.equal(MIXAMO_TO_VRM.Spine1, 'chest');
  assert.equal(MIXAMO_TO_VRM.Spine2, 'upperChest');
  assert.equal(MIXAMO_TO_VRM.Hips, 'hips');
  assert.equal(MIXAMO_TO_VRM.Neck, 'neck');
  assert.equal(MIXAMO_TO_VRM.Head, 'head');
});

test('左右成对：同一部位的左右两侧都存在且互不重叠', () => {
  for (const l of Object.keys(MIXAMO_TO_VRM)) {
    if (!l.startsWith('Left')) continue;
    const r = 'Right' + l.slice(4);
    assert.ok(MIXAMO_TO_VRM[r], `有 ${l} 但没有 ${r}`);
    const lv = MIXAMO_TO_VRM[l];
    const rv = MIXAMO_TO_VRM[r];
    // 'left' 是 4 个字符；切出来再接 'right' → 'leftShoulder' ↔ 'rightShoulder'
    assert.equal(rv, 'right' + lv.slice(4), `${l}/${r} 映射到 ${lv}/${rv}，不对称`);
  }
});

// ---------------------------------------------------------------
// 节点名归一化
// ---------------------------------------------------------------

test('归一化吃掉三种导出器写法（glTF 保留冒号 / 下划线 / FBXLoader 吃掉冒号）', () => {
  const cases = ['mixamorig:Hips', 'mixamorig_Hips', 'mixamorigHips', 'MixamoRig:Hips', 'Hips'];
  for (const c of cases) {
    assert.equal(normalizeBoneName(c).toLowerCase(), 'hips', `解析失败：${c}`);
  }
});

test('归一化不误伤本身带分隔符的规范名', () => {
  // VRM 侧的名字是 camelCase，不该被改动
  assert.equal(normalizeBoneName('leftUpperArm'), 'leftUpperArm');
  assert.equal(normalizeBoneName('upperChest'), 'upperChest');
});

// ---------------------------------------------------------------
// 朝向数学
// ---------------------------------------------------------------

test('左右轴对准 −X：+Z 方向的左右轴需要转 −90°', () => {
  // 面朝 +Z 的角色，其左右轴（右−左）应落在 −X 上。
  // 若模型当前的左右轴指向 +Z（即面朝 +X），需要绕 Y 转 −90°。
  const L = { x: 0, z: 1 };
  assert.ok(Math.abs(lateralToRotateDeg(L) - -90) < 1e-9);
});

test('左右轴已在 −X 上时转角为 0', () => {
  assert.ok(Math.abs(lateralToRotateDeg({ x: -1, z: 0 })) < 1e-9);
});

test('左右轴落在 +X 上（面朝 −Z）时需要转 180°', () => {
  const d = Math.abs(lateralToRotateDeg({ x: 1, z: 0 }));
  assert.ok(Math.abs(d - 180) < 1e-9, `得到 ${d}`);
});

test('脚趾方向（指向前方）转到 +Z', () => {
  assert.ok(Math.abs(toeToRotateDeg({ x: 1, z: 0 }) - -90) < 1e-9);
  assert.ok(Math.abs(toeToRotateDeg({ x: 0, z: 1 })) < 1e-9);
  assert.ok(Math.abs(toeToRotateDeg({ x: -1, z: 0 }) - 90) < 1e-9);
});

test('★ 左右轴与脚趾方向对同一朝向应给出一致估计', () => {
  // 模型面朝 +X：左右轴指向 +Z（人右在 +Z 侧），脚趾指向 +X。
  // 两条独立信号算出的转角必须一致 —— 不一致说明其中一个公式的符号错了。
  const fromLateral = lateralToRotateDeg({ x: 0, z: 1 });
  const fromToe = toeToRotateDeg({ x: 1, z: 0 });
  assert.ok(Math.abs(fromLateral - fromToe) < 1e-9, `${fromLateral} vs ${fromToe}`);
});

// ---------------------------------------------------------------
// 与项目既有真相源保持一致
// ---------------------------------------------------------------

test('规范骨骼表与 web/lib/human-bones-vrm1.json 是同一份（55 根）', () => {
  const onDisk = JSON.parse(
    readFileSync(join(ROOT, 'web/lib/human-bones-vrm1.json'), 'utf8'),
  );
  assert.equal(SPEC_BONES.length, 55);
  assert.deepEqual([...SPEC_BONES].sort(), [...onDisk].sort());
});

/**
 * 骨骼分类规则的测试 —— 直接决定"第三方模型能不能接"。
 *
 * 背景：我们要接入别的同学导出的模型（FBX/GLB → VRM）。那些模型的骨架
 * 几乎不可能刚好有 VRM 1.0 规范的全部 55 根 —— 最常见的是**没有手指**、
 * 没有 upperChest、没有眼球骨。
 *
 * 早期实现把"名字非法"和"模型没这根"混在一起，一律整体拒绝写入，
 * 结果是：接一具缺手指的模型时，一条含手指的 clip 会让**整个角色一动不动**。
 * 那是设计缺陷，不是模型的错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyBones } from '../web/lib/bone-classify.ts';

const FULL = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightIndexProximal'];

test('全部命中：没有缺失、没有非法', () => {
  const r = classifyBones(['hips', 'head'], new Set(['hips', 'head']), FULL);
  assert.deepEqual(r, { ok: true, missing: [], unknown: [] });
});

test('★ 模型天然缺骨骼 → missing（不是拒绝）', () => {
  // 例如 Seed-san 没有 upperChest；第三方模型常见的没有手指
  const r = classifyBones(['hips', 'upperChest', 'rightIndexProximal'], new Set(['hips']), FULL);
  assert.equal(r.ok, true, '模型缺合法骨骼不该导致整体拒绝');
  assert.deepEqual(r.missing.sort(), ['rightIndexProximal', 'upperChest']);
  assert.deepEqual(r.unknown, []);
});

test('★ 非法骨骼名 → unknown（必须整体拒绝）', () => {
  // 写错名、或者 rigProfile 根本不是 VRM（比如从 FBX 直接来的原始骨骼名）
  const r = classifyBones(
    ['hips', 'mixamorig:Hips', 'Bip01 Head', 'rightIndexProximal'],
    new Set(['hips']),
    FULL,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown.sort(), ['Bip01 Head', 'mixamorig:Hips']);
  assert.deepEqual(r.missing, ['rightIndexProximal'], '合法的缺骨骼仍归 missing');
});

test('两者可以同时出现，但只有 unknown 触发拒绝', () => {
  const r = classifyBones(['upperChest', 'typoBone'], new Set([]), FULL);
  assert.equal(r.ok, false, '有非法名 → 拒绝');
  assert.deepEqual(r.missing, ['upperChest']);
  assert.deepEqual(r.unknown, ['typoBone']);
});

test('空输入安全', () => {
  assert.deepEqual(classifyBones([], new Set(), FULL), { ok: true, missing: [], unknown: [] });
});

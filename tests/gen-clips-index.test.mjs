/**
 * 动作目录合并规则的测试。
 *
 * 这条规则坏掉的表现特别隐蔽：文件都在磁盘上，只是从目录里消失了，
 * 看起来像"动作丢了"或者"保存没生效"。而且它只在**跨来源**时才暴露 ——
 * 单独跑生成器或单独录动作都不会发现问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeCatalog,
  preserveNonGenerated,
  isGeneratedEntry,
} from '../web/lib/clip-catalog-merge.ts';

const gen = (id) => ({ id, name: id, url: `/clips/${id}.json`, source: 'generated', fps: 30, duration: 1, frameCount: 31, mask: [] });
const mocap = (id) => ({ id, name: id, url: `/clips/${id}.json`, source: 'mocap', fps: 30, duration: 1, frameCount: 31, mask: [], captureId: id });

test('isGeneratedEntry 只认 source === "generated"', () => {
  assert.equal(isGeneratedEntry(gen('a')), true);
  assert.equal(isGeneratedEntry(mocap('a')), false);
  assert.equal(isGeneratedEntry({ id: 'x' }), false, '没有 source 的旧数据不算生成器所有');
  assert.equal(isGeneratedEntry(null), false);
  assert.equal(isGeneratedEntry('x'), false);
});

test('preserveNonGenerated 取出来自其它来源的条目', () => {
  const existing = { clips: [gen('g1'), mocap('m1'), gen('g2'), { id: 'imp', source: 'imported' }] };
  assert.deepEqual(
    preserveNonGenerated(existing).map((c) => c.id),
    ['m1', 'imp'],
  );
});

test('preserveNonGenerated 对缺失/畸形输入返回空数组而不是抛错', () => {
  assert.deepEqual(preserveNonGenerated(null), []);
  assert.deepEqual(preserveNonGenerated({}), []);
  assert.deepEqual(preserveNonGenerated({ clips: 'not an array' }), []);
});

test('★ 合并后：生成器的新条目在前，其它来源的保留', () => {
  const existing = { clips: [gen('old-gen'), mocap('keep-me')] };
  const merged = mergeCatalog(existing, [gen('new1'), gen('new2')]);
  assert.deepEqual(
    merged.clips.map((c) => c.id),
    ['new1', 'new2', 'keep-me'],
    '录下来的动作不能在重新生成时消失',
  );
});

test('★ 旧的 generated 条目被替换掉，不会重复累积', () => {
  const existing = { clips: [gen('a'), gen('b'), mocap('m')] };
  const merged = mergeCatalog(existing, [gen('a'), gen('b')]);
  assert.deepEqual(merged.clips.map((c) => c.id), ['a', 'b', 'm']);
  assert.equal(merged.clips.filter((c) => c.id === 'a').length, 1, '不该出现重复的 a');
});

test('★ 目录里与生成器无关的字段被保留（将来加版本号也不会被无声抹掉）', () => {
  const existing = { version: 2, stats: { total: 3 }, clips: [mocap('m')] };
  const merged = mergeCatalog(existing, [gen('g')]);
  assert.equal(merged.version, 2);
  assert.deepEqual(merged.stats, { total: 3 });
});

test('空目录 / 文件不存在时按空目录处理', () => {
  assert.deepEqual(mergeCatalog(null, [gen('a')]).clips.map((c) => c.id), ['a']);
  assert.deepEqual(mergeCatalog({}, [gen('a')]).clips.map((c) => c.id), ['a']);
});

test('生成器产出为空时不会把 mocap 条目一起清掉', () => {
  const existing = { clips: [gen('a'), mocap('m1'), mocap('m2')] };
  const merged = mergeCatalog(existing, []);
  assert.deepEqual(merged.clips.map((c) => c.id), ['m1', 'm2']);
});

test('多来源混合时按块排列，且不丢任何一条', () => {
  const existing = {
    clips: [gen('g1'), mocap('m1'), { id: 'i1', source: 'imported' }, gen('g2')],
  };
  const merged = mergeCatalog(existing, [gen('g1'), gen('g2')]);
  const ids = merged.clips.map((c) => c.id);
  assert.equal(ids.length, 4);
  for (const id of ['g1', 'g2', 'm1', 'i1']) assert.ok(ids.includes(id), `${id} 丢了`);
});

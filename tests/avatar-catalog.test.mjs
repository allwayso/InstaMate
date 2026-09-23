/**
 * 资产目录的纯逻辑测试。
 *
 * 重点不是"正常路径能跑"，而是**异常输入不能让整个列表挂掉**：
 * 资产选择器是辅助功能，一个坏 .vrm 文件不该让下拉变空、
 * 更不该让页面报错。所以这里专门测垃圾输入、空目录、目录不存在三种情况。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FALLBACK_AVATARS,
  buildAvatarCatalog,
  listVrmFiles,
  summarizeVrm,
} from '../web/lib/avatar-catalog.ts';

// ---------------------------------------------------------------
// 造一个最小 GLB（只需 JSON chunk）——测试不该依赖真实的 16 MB 资产
// ---------------------------------------------------------------

function makeGlb(json, { binBytes = 0 } = {}) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.alloc(binBytes);

  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'ascii');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonChunk.length + (binBytes ? 8 + binChunk.length : 0), 8);

  const jHead = Buffer.alloc(8);
  jHead.writeUInt32LE(jsonChunk.length, 0);
  jHead.write('JSON', 4, 'ascii');

  const parts = [head, jHead, jsonChunk];
  if (binBytes) {
    const bHead = Buffer.alloc(8);
    bHead.writeUInt32LE(binChunk.length, 0);
    bHead.writeUInt32LE(0x004e4942, 4);
    parts.push(bHead, binChunk);
  }
  return Buffer.concat(parts);
}

const VRM_JSON = {
  asset: { version: '2.0', generator: 'test' },
  extensionsUsed: ['VRMC_vrm'],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: { name: '测试角色' },
      humanoid: { humanBones: { hips: { node: 0 }, spine: { node: 1 }, head: { node: 2 } } },
    },
  },
};

// ---------------------------------------------------------------
// summarizeVrm
// ---------------------------------------------------------------

test('能读出 VRM 的名称 / 骨骼数 / specVersion', () => {
  const r = summarizeVrm(makeGlb(VRM_JSON));
  assert.equal(r?.name, '测试角色');
  assert.equal(r?.boneCount, 3);
  assert.equal(r?.specVersion, '1.0');
});

test('★ 垃圾输入返回 null 而不是抛错（一个坏文件不该让整个列表挂掉）', () => {
  const cases = [
    ['空 buffer', Buffer.alloc(0)],
    ['太短', Buffer.alloc(8)],
    ['魔数不对', Buffer.from('not a glb at all, really not', 'ascii')],
    ['是 GLB 但没有 JSON chunk', (() => {
      const b = Buffer.alloc(12 + 8);
      b.write('glTF', 0, 'ascii');
      b.writeUInt32LE(2, 4);
      b.writeUInt32LE(20, 8);
      b.writeUInt32LE(0, 12);
      b.writeUInt32LE(0x004e4942, 16);
      return b;
    })()],
    ['JSON 合法但不是 VRM', makeGlb({ asset: { version: '2.0' } })],
  ];
  for (const [label, buf] of cases) {
    assert.doesNotThrow(() => summarizeVrm(buf), `${label} 抛错了`);
    assert.equal(summarizeVrm(buf), null, `${label} 应返回 null`);
  }
});

test('缺 meta.name / humanBones 时字段为 null，但整体仍可用', () => {
  const r = summarizeVrm(makeGlb({
    extensions: { VRMC_vrm: { specVersion: '1.0', meta: {}, humanoid: {} } },
  }));
  assert.ok(r, '不应整体返回 null');
  assert.equal(r.name, null);
  assert.equal(r.boneCount, null);
  assert.equal(r.specVersion, '1.0');
});

test('带 BIN chunk 也能正确找到 JSON chunk（chunk 顺序不应被假定）', () => {
  const r = summarizeVrm(makeGlb(VRM_JSON, { binBytes: 1024 }));
  assert.equal(r?.name, '测试角色');
});

// ---------------------------------------------------------------
// listVrmFiles / buildAvatarCatalog
// ---------------------------------------------------------------

function withTempPublic(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-catalog-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('目录不存在时返回空数组（干净克隆还没跑 fetch-assets）', () => {
  withTempPublic((dir) => {
    assert.deepEqual(listVrmFiles(join(dir, 'avatars')), []);
  });
});

test('只认 .vrm，忽略大小写，忽略子目录', () => {
  withTempPublic((dir) => {
    const a = join(dir, 'avatars');
    mkdirSync(join(a, 'sub'), { recursive: true });
    writeFileSync(join(a, 'b.vrm'), 'x');
    writeFileSync(join(a, 'A.VRM'), 'x');
    writeFileSync(join(a, 'c.glb'), 'x');
    writeFileSync(join(a, 'readme.txt'), 'x');
    const got = listVrmFiles(a).map((f) => f.file);
    assert.deepEqual(got, ['A.VRM', 'b.vrm'], `实际：${got.join(', ')}`);
  });
});

test('★ 目录为空时退回兜底列表（否则干净克隆下下拉会是空的）', () => {
  withTempPublic((dir) => {
    const cat = buildAvatarCatalog(dir);
    assert.deepEqual(
      cat.map((e) => e.url),
      [...FALLBACK_AVATARS],
    );
  });
});

test('正常目录：读出条目并附带摘要', () => {
  withTempPublic((dir) => {
    const a = join(dir, 'avatars');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'hero.vrm'), makeGlb(VRM_JSON));
    writeFileSync(join(a, 'broken.vrm'), Buffer.from('这不是 GLB'));

    const cat = buildAvatarCatalog(dir);
    assert.equal(cat.length, 2, `条目数 ${cat.length}`);

    const hero = cat.find((e) => e.file === 'hero.vrm');
    assert.equal(hero?.url, '/avatars/hero.vrm');
    assert.equal(hero?.name, '测试角色');
    assert.equal(hero?.boneCount, 3);

    // 坏文件仍在列表里（可选），只是摘要为 null —— 不该被静默丢掉
    const broken = cat.find((e) => e.file === 'broken.vrm');
    assert.ok(broken, '坏文件被丢掉了');
    assert.equal(broken?.name, null);
    assert.equal(broken?.bytes > 0, true);
  });
});

test('include 能补齐目录外的 URL（保证 ?avatar= 指向的项能被选中）', () => {
  withTempPublic((dir) => {
    const a = join(dir, 'avatars');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'hero.vrm'), makeGlb(VRM_JSON));

    const cat = buildAvatarCatalog(dir, { include: ['/tmp/custom.vrm', '/avatars/hero.vrm'] });
    const urls = cat.map((e) => e.url);
    assert.ok(urls.includes('/tmp/custom.vrm'), '外部 URL 没被补进来');
    assert.equal(urls.filter((u) => u === '/avatars/hero.vrm').length, 1, '重复补齐了');
  });
});

/**
 * 动作库保存规则的纯逻辑测试（不需要服务器，不需要文件系统）。
 *
 * 这些函数被抽到 web/lib/motion-library-rules.ts 就是因为要覆盖到这里：
 * 它们全是"拒绝"逻辑 —— 非法 ID、路径穿越、超长名称、生产环境写入闸门。
 * 拒绝逻辑不写测试的话，最典型的下场是"看着有校验，其实一个都没拦住"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateId,
  checkOrigin,
  checkWriteEnabled,
  defaultId,
  validateDisplayName,
  validateRequestedId,
  ID_MAX,
  MAX_BODY_BYTES,
  NAME_MAX,
} from '../web/lib/motion-library-rules.ts';

// ── displayName ──────────────────────────────────────────────────────────

test('displayName：1–40 字符', () => {
  assert.equal(validateDisplayName('挥手'), null);
  assert.equal(validateDisplayName('  挥手  '), null, '两端空白会被 trim，长度按 trim 后算');
  assert.ok(validateDisplayName('  ' ) !== null, '纯空白 trim 后为空，应当拒绝');
});

test('displayName：空串 / 纯空白 / 超长一律拒绝', () => {
  assert.ok(validateDisplayName('') !== null);
  assert.ok(validateDisplayName('   ') !== null);
  assert.ok(validateDisplayName('a'.repeat(NAME_MAX + 1)) !== null);
  assert.equal(validateDisplayName('a'.repeat(NAME_MAX)), null);
  assert.ok(validateDisplayName(123) !== null);
  assert.ok(validateDisplayName(null) !== null);
});

// ── requestedId ──────────────────────────────────────────────────────────

test('requestedId：只允许小写字母、数字、连字符', () => {
  for (const ok of ['mocap-20260922-120000', 'a', 'abc-123', 'x'.repeat(ID_MAX)]) {
    assert.equal(validateRequestedId(ok), null, `${ok} 应被接受`);
  }
  for (const bad of ['ABC', 'a_b', 'a b', '中文', 'a.b', 'a'.repeat(ID_MAX + 1)]) {
    assert.ok(validateRequestedId(bad) !== null, `${bad} 应被拒绝`);
  }
});

test('★ requestedId：拒绝路径穿越（id 会直接拼进文件名）', () => {
  for (const bad of ['../etc/passwd', 'a/../b', '..', 'a/b', 'a\\b', '/abs', 'C:\\x', './x']) {
    assert.ok(validateRequestedId(bad) !== null, `${bad} 必须被拒绝`);
  }
});

test('requestedId：未提供时返回 null（表示"用默认名"，不是错误）', () => {
  assert.equal(validateRequestedId(undefined), null);
  assert.equal(validateRequestedId(null), null);
  assert.equal(validateRequestedId(''), null);
});

// ── defaultId ────────────────────────────────────────────────────────────

test('默认 ID 形如 mocap-YYYYMMDD-HHmmss 且自身合法', () => {
  const id = defaultId(new Date(2026, 8, 22, 19, 5, 7));
  assert.equal(id, 'mocap-20260922-190507');
  assert.equal(validateRequestedId(id), null, '默认名自己必须能通过校验');
});

// ── allocateId（同名 → -2）──────────────────────────────────────────────

test('★ 同名保存得到 -2、-3', () => {
  const taken = new Set();
  const exists = () => false;
  assert.equal(allocateId('wave', taken, exists), 'wave');
  taken.add('wave');
  assert.equal(allocateId('wave', taken, exists), 'wave-2');
  taken.add('wave-2');
  assert.equal(allocateId('wave', taken, exists), 'wave-3');
});

test('★ 只看目录会漏掉"文件在但没进目录"的中间状态，所以还要查磁盘', () => {
  const taken = new Set();
  // 目录里没有 wave，但磁盘上有 —— 必须仍然避开
  assert.equal(allocateId('wave', taken, (id) => id === 'wave'), 'wave-2');
  assert.equal(allocateId('wave', taken, (id) => id === 'wave' || id === 'wave-2'), 'wave-3');
});

test('编号耗尽时抛出而不是静默覆盖', () => {
  assert.throws(() => allocateId('x', new Set(), () => true), /未占用的编号/);
});

// ── 写入闸门 ─────────────────────────────────────────────────────────────

test('★ 生产环境默认禁止写入，需显式开 MOTION_LIBRARY_WRITE_ENABLED=1', () => {
  const prod = { NODE_ENV: 'production' };
  assert.equal(checkWriteEnabled(prod).allowed, false);
  assert.equal(checkWriteEnabled(prod).status, 403);
  assert.equal(checkWriteEnabled({ ...prod, MOTION_LIBRARY_WRITE_ENABLED: '1' }).allowed, true);
  // 任何其它值都不算开启
  assert.equal(checkWriteEnabled({ ...prod, MOTION_LIBRARY_WRITE_ENABLED: 'true' }).allowed, false);
  assert.equal(checkWriteEnabled({ ...prod, MOTION_LIBRARY_WRITE_ENABLED: '0' }).allowed, false);
});

test('开发环境允许写入', () => {
  assert.equal(checkWriteEnabled({ NODE_ENV: 'development' }).allowed, true);
});

// ── 同源与 localhost ────────────────────────────────────────────────────

test('★ 跨源写入被拒', () => {
  const d = checkOrigin({ origin: 'http://evil.example', host: 'localhost:3000' });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 403);
  assert.ok(d.reason?.includes('跨源'));
});

test('同源写入放行（含端口一致）', () => {
  assert.equal(checkOrigin({ origin: 'http://localhost:3000', host: 'localhost:3000' }).allowed, true);
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }).allowed, true);
});

test('端口不同也算跨源', () => {
  assert.equal(checkOrigin({ origin: 'http://localhost:3001', host: 'localhost:3000' }).allowed, false);
});

test('非法 Origin 被拒而不是放过', () => {
  assert.equal(checkOrigin({ origin: 'not a url', host: 'localhost:3000' }).allowed, false);
});

test('★ 非 localhost 且未显式开启时拒写（避免局域网里被人写入）', () => {
  const d = checkOrigin({ origin: null, host: '192.168.1.20:3000' });
  assert.equal(d.allowed, false);
  assert.ok(d.reason?.includes('localhost'));
  assert.equal(
    checkOrigin({ origin: null, host: '192.168.1.20:3000' }, { MOTION_LIBRARY_WRITE_ENABLED: '1' }).allowed,
    true,
  );
});

test('无 Origin 头（同源导航/curl）在 localhost 下放行', () => {
  assert.equal(checkOrigin({ origin: null, host: 'localhost:3000' }).allowed, true);
});

// ── 体积上限 ─────────────────────────────────────────────────────────────

test('请求体上限是 32 MiB（10 秒原始关键点约 5–10 MB，留了余量）', () => {
  assert.equal(MAX_BODY_BYTES, 32 * 1024 * 1024);
});

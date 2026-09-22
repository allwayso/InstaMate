/**
 * 保存 API 的集成测试（需要真跑起来的 dev/prod 服务器）。
 *
 * ⚠️ 这个测试会**真的写入** web/public/clips/ 与 data/mocap/，
 *    所以它自己负责清理：开始前快照 index.json，结束后还原并删掉本次创建的文件。
 *    这是刻意的 —— "写入失败不破坏原 index" 这条只有在真实文件系统上才算验过。
 *
 * 服务器没起时整体 skip，不报失败（这样 npm test 在没起服务器的情况下仍然全绿）。
 *
 *   cd web && npm run dev            # 另一个终端
 *   cd web && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const BASE = process.env.MOTION_LIBRARY_BASE ?? 'http://localhost:3000';
const WEB_ROOT = new URL('../web/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLIPS_DIR = `${WEB_ROOT}public/clips`;
const INDEX_PATH = `${CLIPS_DIR}/index.json`;
const MOCAP_DIR = `${WEB_ROOT}../data/mocap`;

let available = false;
let indexSnapshot = null;
const createdFiles = [];

before(async () => {
  try {
    const res = await fetch(`${BASE}/api/motion-library`, { signal: AbortSignal.timeout(2500) });
    available = res.ok;
  } catch {
    available = false;
  }
  if (!available) {
    console.log(`\n[skip] ${BASE} 上没有服务器，跳过动作库 API 集成测试`);
    console.log('       起服务器：cd web && npm run dev\n');
    return;
  }
  if (existsSync(INDEX_PATH)) indexSnapshot = readFileSync(INDEX_PATH, 'utf8');
});

after(() => {
  // 还原动作目录并删掉本次产物 —— 测试不该在仓库里留东西
  if (indexSnapshot !== null) writeFileSync(INDEX_PATH, indexSnapshot, 'utf8');
  for (const f of createdFiles) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
  if (createdFiles.length) console.log(`\n[cleanup] 已还原 index.json，删除 ${createdFiles.length} 个测试产物`);
});

/** 一个合法的最小 clip（2 帧，只有一条轨道） */
function goodClip(name = 'api-test') {
  return {
    schemaVersion: 1,
    rigProfile: 'vrm-normalized-v1',
    name,
    space: 'normalized-local',
    rotationMode: 'absolute',
    quaternionOrder: 'xyzw',
    fps: 30,
    frameCount: 2,
    duration: 1 / 30,
    loop: false,
    rootMotion: 'locked',
    mask: ['rightUpperArm'],
    bones: {
      rightUpperArm: [
        [0, 0, 0, 1],
        [0, 0, 0.0087265, 0.9999619],
      ],
    },
  };
}

async function post(body) {
  const res = await fetch(`${BASE}/api/motion-library`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 可能是空体 */
  }
  return { status: res.status, json };
}

/**
 * ★ 注意：不能写成 `test(name, { skip: !available }, fn)`。
 *   测试注册是**即时**发生的，那时候 before 钩子还没跑、available 还是 false，
 *   结果 14 个用例全被静默跳过（第一次就是这么栽的：ℹ pass 0 / skipped 14）。
 *   所以把判断放进测试体内。
 */
const testFn = (name, fn) =>
  test(name, async (t) => {
    if (!available) {
      t.skip('没有可用服务器');
      return;
    }
    await fn();
  });

// ── GET ──────────────────────────────────────────────────────────────────

testFn('GET 返回动作目录', async () => {
  const res = await fetch(`${BASE}/api/motion-library`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.clips));
});

// ── POST 拒绝路径 ────────────────────────────────────────────────────────

testFn('★ 拒绝非法 requestedId（含路径穿越）', async () => {
  for (const bad of ['../evil', 'a/b', 'ABC', 'a b', '中文']) {
    const { status, json } = await post({ requestedId: bad, displayName: 'x', clip: goodClip() });
    assert.equal(status, 400, `${bad} 应被拒绝，实际 ${status} ${JSON.stringify(json)}`);
    assert.equal(json.ok, false);
  }
});

testFn('★ 拒绝非法 displayName', async () => {
  for (const bad of ['', '   ', 'x'.repeat(41)]) {
    const { status } = await post({ displayName: bad, clip: goodClip() });
    assert.equal(status, 400, `displayName=${JSON.stringify(bad)} 应被拒绝`);
  }
});

testFn('★ 拒绝非法 clip（服务端必须重新校验，不能信任客户端）', async () => {
  const bad = goodClip();
  bad.frameCount = 99; // 与轨道长度不符
  const { status, json } = await post({ displayName: '坏 clip', clip: bad });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.ok(Array.isArray(json.issues) && json.issues.length > 0, '应当给出具体 issues');
});

testFn('拒绝非 JSON 请求体', async () => {
  const { status } = await post('这不是 json');
  assert.equal(status, 400);
});

testFn('拒绝缺少 clip 的请求', async () => {
  const { status } = await post({ displayName: '没有 clip' });
  assert.equal(status, 400);
});

testFn('★ 拒绝超大请求体（413）', async () => {
  // 32 MiB 上限 + 1 MiB
  const huge = 'x'.repeat(33 * 1024 * 1024);
  const { status } = await post(`{"displayName":"大","clip":{},"pad":"${huge}"}`);
  assert.equal(status, 413, `超大请求应当 413，实际 ${status}`);
});

// ── POST 成功路径 ────────────────────────────────────────────────────────

testFn('★ 保存成功：写入 clip、更新目录、返回新 id 与条目', async () => {
  const id = `api-test-${Date.now().toString(36)}`;
  const { status, json } = await post({
    requestedId: id,
    displayName: 'API 测试动作',
    clip: goodClip(),
    capture: null,
  });
  createdFiles.push(`${CLIPS_DIR}/${id}.json`);
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.ok, true);
  assert.equal(json.id, id, '指定的 id 没被占用时应当原样使用');
  assert.equal(json.entry.source, 'mocap');
  assert.equal(json.entry.captureId, null, '没有原始关键点时 captureId 必须是 null');
  assert.equal(json.entry.trackingValidRatio, undefined, '没有 capture 时不该伪造有效率');

  // 文件真的落盘了，且内容里的 name 被改成了最终 id
  assert.ok(existsSync(`${CLIPS_DIR}/${id}.json`), 'clip 文件应当已写入');
  const saved = JSON.parse(readFileSync(`${CLIPS_DIR}/${id}.json`, 'utf8'));
  assert.equal(saved.name, id, '服务端应当把 clip.name 定为最终 id');

  // 目录里能查到，并且能被 GET 返回
  const list = await (await fetch(`${BASE}/api/motion-library`)).json();
  assert.ok(list.clips.some((c) => c.id === id), '新动作应当出现在目录里');
});

testFn('★ 同名保存得到 -2', async () => {
  const id = `api-dup-${Date.now().toString(36)}`;
  const first = await post({ requestedId: id, displayName: '同名', clip: goodClip() });
  createdFiles.push(`${CLIPS_DIR}/${id}.json`);
  assert.equal(first.status, 201);
  assert.equal(first.json.id, id);

  const second = await post({ requestedId: id, displayName: '同名', clip: goodClip() });
  createdFiles.push(`${CLIPS_DIR}/${id}-2.json`);
  assert.equal(second.status, 201, JSON.stringify(second.json));
  assert.equal(second.json.id, `${id}-2`, '同名应当自动追加 -2');
});

testFn('未指定 id 时自动生成 mocap-YYYYMMDD-HHmmss', async () => {
  const { status, json } = await post({ displayName: '自动命名', clip: goodClip() });
  if (json?.id) createdFiles.push(`${CLIPS_DIR}/${json.id}.json`);
  assert.equal(status, 201, JSON.stringify(json));
  assert.match(json.id, /^mocap-\d{8}-\d{6}(-\d+)?$/, `默认名格式不对：${json.id}`);
});

// ── 原始关键点 ───────────────────────────────────────────────────────────

testFn('没有原始关键点时下载返回 404，并给出人能看懂的原因', async () => {
  const res = await fetch(`${BASE}/api/motion-library/${'nonexistent-' + Date.now().toString(36)}/landmarks`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.ok(data.error.includes('data/mocap'), '应当说明原始关键点存在哪里');
});

testFn('★ 下载接口拒绝路径穿越的 id', async () => {
  const res = await fetch(`${BASE}/api/motion-library/..%2f..%2fetc%2fpasswd/landmarks`);
  assert.ok(res.status === 400 || res.status === 404, `应当拒绝，实际 ${res.status}`);
});

// ── 目录完整性 ───────────────────────────────────────────────────────────

testFn('★ 一系列写入之后，原有动作一个都没丢', async () => {
  if (!indexSnapshot) return;
  const before = JSON.parse(indexSnapshot).clips.map((c) => c.id).sort();
  const now = (await (await fetch(`${BASE}/api/motion-library`)).json()).clips.map((c) => c.id).sort();
  for (const id of before) {
    assert.ok(now.includes(id), `原有动作 ${id} 在写入后消失了`);
  }
});

testFn('目录 JSON 仍然可解析（没有被写坏）', async () => {
  const raw = readFileSync(INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.clips));
});

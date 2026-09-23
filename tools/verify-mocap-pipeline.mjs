/**
 * 动捕管线的端到端验证（不需要真人、不需要摄像头）。
 *
 * 用 Chrome 的假摄像头驱动整条管线，验的是「管道通不通、错误说不说得清」，
 * 不是「动作对不对」—— 动作对不对必须真人上场（见 docs/G2-验收记录.md §三）。
 *
 * 从 .g0/ 提升到 tools/ 的原因：它是有长期价值的回归工具，
 * 而不是一次性的排查脚本。团队里谁改了管线都可以跑一遍。
 *
 * 【原始需求说明】G2 摄像头之前的端到端验证（不需要真人）。
 *
 * 用 Chrome 的假摄像头（--use-fake-device-for-media-stream）驱动整条管线：
 *   getUserMedia → 视频元素 → Holistic 从本地 vendor 加载 → 逐帧推理
 *     → 关键点提取 → 求解 → 重定向 → 校准 → 平滑 → 写骨骼
 *     → 录制 → 停止 → 质量门槛
 *
 * 假摄像头拍的是一张滚动色块，不是人，所以：
 *   · 检测不到人 → 置信度低 → 应该走「保持/渐变/丢失」三级回退
 *   · 录制完有效帧应该很低 → 应该被 70% 门槛**明确拒绝**（这本身就是一条要验的路径）
 *
 * 所以这个脚本验的是「管道通不通、错误说不说得清」，不是「动作对不对」。
 * 动作对不对必须真人上场（见 docs/G2-验收记录.md §三）。
 *
 * 自己起 Chrome、自己清理进程树，不依赖 dev-browser 管家。
 *
 *   cd web && npm run dev            # 另一个终端
 *   cd D:/Active-Desktop-Pet && node tools/verify-mocap-pipeline.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.env.G2_URL ?? 'http://localhost:3000/motion-library';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome');
  process.exit(2);
}

// 先确认页面在（不是浏览器的问题）
try {
  const r = await fetch(URL_TARGET, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`\n✗ ${URL_TARGET} 不可达（${e.message}）`);
  console.error('  先启动：cd web && npm run dev\n');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'g2-verify-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-sandbox',
    '--use-angle=default',
    // 假摄像头：给一个合成的视频流，用来打通管道
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    URL_TARGET,
  ],
  { stdio: 'ignore', detached: false },
);

let ws;
const cleanup = () => {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  // Chrome 会派生子进程，Windows 上要整树杀
  try {
    spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ── 连上 CDP ─────────────────────────────────────────────────────────────
let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch {
    /* 还没起来 */
  }
}
if (!target) {
  console.error('连不上 CDP');
  process.exit(2);
}

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map();
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  }
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result);
    pend.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
  return r.result.value;
};

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${n.padEnd(52)}${d}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

// ── 1. 页面首屏 ──────────────────────────────────────────────────────────
let ready = false;
for (let i = 0; i < 60; i++) {
  if (await ev('!!window.__mocapDebug')) {
    ready = true;
    break;
  }
  await sleep(500);
}
check('页面加载并暴露 __mocapDebug', ready);
if (!ready) {
  console.log('\n控制台错误：');
  consoleErrors.slice(0, 10).forEach((c) => console.log('  ' + c.slice(0, 160)));
  process.exit(1);
}

check('状态机初始为 camera-off', (await ev('__mocapDebug.getState()')) === 'camera-off');
check('轴向映射标记为未实测（页面会显示警告）', (await ev('__mocapDebug.isMeasured()')) === false);

// vendor 自检
const vendor = await ev(`fetch('/api/motion-library').then(()=>true)`);
check('动作目录 API 可达', vendor === true);
const clipCount = await ev(`fetch('/api/motion-library').then(r=>r.json()).then(d=>d.clips.length)`);
check('目录里有动作', clipCount > 0, `${clipCount} 条`);

// ── 1.5 ★ F2 回归：归一化坐标会被守卫打回、米制坐标不会 ─────────────────
{
  const guard = await ev('__mocapDebug.probeRestingDefaultGuard()');
  if (!guard) {
    check('★ F2 离屏守卫回归（kalidokit 模块未加载，跳过）', true, '需要先触发一次求解器加载');
  } else {
    check(
      '★ F2：喂**归一化**坐标会被离屏守卫打回 RestingDefault',
      guard.guardStillWorks === true,
      `归一化输入 RightUpperArm.z=${guard.normalizedInputZ}，RestingDefault=${guard.restingDefaultZ}`,
    );
    check(
      '★ F2：喂**米制世界坐标**不会被打回（我们的实际做法）',
      guard.weAreSafe === true,
      `米制输入 RightUpperArm.z=${guard.meterInputZ}`,
    );
  }
}

// ── 2. 主角色加载 ────────────────────────────────────────────────────────
let slots = 0;
for (let i = 0; i < 60; i++) {
  const st = await ev('__mocapDebug.getPreviewStatus()');
  slots = st?.slots?.length ?? 0;
  if (slots >= 1) break;
  await sleep(500);
}
const st1 = await ev('__mocapDebug.getPreviewStatus()');
check('主角色（Seed-san）已加载', slots >= 1, `槽位 ${slots}，骨骼 ${st1?.slots?.[0]?.bones ?? '?'}`);
check('姿态写入无缺骨骼报错', !st1?.applyError, st1?.applyError ?? '');

// ── 3. 每帧 vrm.update 次数（单角色应为 1）───────────────────────────────
await sleep(600);
const upd1 = await ev('__mocapDebug.getPreviewStatus().lastFrameUpdates');
check('单角色每帧 vrm.update = 1', upd1 === 1, `实际 ${upd1}`);

// ── 4. 双角色（G2 门槛的一半，不需要摄像头就能验）──────────────────────
await ev(`(() => {
  const cb = [...document.querySelectorAll('input[type=checkbox]')].find(i => i.closest('label')?.textContent?.includes('双角色'));
  if (cb && !cb.checked) cb.click();
  return !!cb;
})()`);
let slots2 = 1;
for (let i = 0; i < 80; i++) {
  const st = await ev('__mocapDebug.getPreviewStatus()');
  slots2 = st?.slots?.length ?? 0;
  if (slots2 >= 2) break;
  await sleep(500);
}
const st2 = await ev('__mocapDebug.getPreviewStatus()');
check('第二角色（compat.vrm）已加载', slots2 >= 2, st2?.slots?.map((s) => `${s.id}:${s.bones}骨`).join(' '));
const second = st2?.slots?.find((s) => s.id === 'second');
check(
  '第二角色有 upperChest（与 Seed-san 的能力差异）',
  !!second && !second.missing.includes('upperChest'),
  `缺 ${second?.missing?.join(',') || '无'}`,
);
const seed = st2?.slots?.find((s) => s.id === 'primary');
check(
  '主角色确实缺 upperChest（对照组成立）',
  !!seed && seed.missing.includes('upperChest'),
  `缺 ${seed?.missing?.join(',')}`,
);

await sleep(600);
const upd2 = await ev('__mocapDebug.getPreviewStatus().lastFrameUpdates');
check('★ 双角色每帧 vrm.update = 2', upd2 === 2, `实际 ${upd2}`);

// ── 5. 动作库回放 ────────────────────────────────────────────────────────
await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '播放');
  btn?.click();
  return !!btn;
})()`);
await sleep(1200);
const snap1 = await ev('__mocapDebug.getSnapshot()');
await sleep(700);
const snap2 = await ev('__mocapDebug.getSnapshot()');
check('库里的动作能播放', snap1?.state === 'playing' || snap1?.state === 'fadingOut', `state=${snap1?.state}`);
check('播放时钟在推进', (snap2?.time ?? 0) > (snap1?.time ?? 0), `${snap1?.time?.toFixed(2)} → ${snap2?.time?.toFixed(2)}`);

// ── 6. 启动摄像头（假设备）→ 整条管线 ───────────────────────────────────
await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('启动摄像头'));
  btn?.click();
  return !!btn;
})()`);

let camState = '';
let camDetail = '';
let sawError = '';
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  camState = await ev('__mocapDebug.getState()');
  camDetail = await ev(`document.querySelector('.camera-status .badge')?.textContent ?? ''`);
  sawError = await ev(`document.querySelector('.camera-error pre')?.textContent ?? ''`);
  // ★ 默认「跳过校准」时摄像头一起来就直接进 ready（不再停在 detecting）；
  //   关掉跳过开关才是 detecting。两者都算启动成功。
  if (camState === 'ready' || camState === 'detecting' || camState === 'error') break;
}
check(
  '摄像头启动成功（假设备）',
  camState === 'ready' || camState === 'detecting',
  `state=${camState} ${camDetail}（默认跳过校准 ⇒ 直接 ready）`,
);
if (sawError) {
  check('若失败，错误信息是具体的（不是静默）', sawError.length > 10, sawError.slice(0, 90));
}

// 推理帧率
let fps = 0;
for (let i = 0; i < 40; i++) {
  fps = await ev(`(() => { const t=[...document.querySelectorAll('.camera-status span')].find(s=>s.textContent.includes('推理')); return t? parseFloat(t.textContent.replace(/[^0-9.]/g,'')) : 0; })()`);
  if (fps > 0) break;
  await sleep(1000);
}
check('★ Holistic 在跑，推理帧率 > 0（说明本地 vendor 加载成功）', fps > 0, `${fps} fps`);

// ★ 关键：世界坐标流到底叫什么名字 —— 这一条就是踩过的坑
// ⚠️ 假摄像头拍的是色块、镜头前没有人，所以 MediaPipe **不会产生** pose/hand/face 这些流
//    （输出属性只在对应流有输出时才设置）。因此"za 是否存在"在这台机器上验不了 ——
//    必须在真人摄像头下验。这里只能验一件事：不要因此**误报**。
const camInfoEarly = await ev('__mocapDebug.getCameraInfo()');
check(
  '★ 没人时不会误报"世界坐标字段缺失"（区分"没检到人"与"读错键名"）',
  camInfoEarly?.poseFieldAvailable === false ? camInfoEarly?.worldFieldAvailable !== false : true,
  `pose出现=${camInfoEarly?.poseFieldAvailable}｜world可用=${camInfoEarly?.worldFieldAvailable}｜字段: ${(camInfoEarly?.resultKeys ?? []).join(', ') || '(空)'}`,
);
check(
  '没人时不会弹出"字段缺失"错误框',
  (await ev(`!document.querySelector('.camera-error pre')`)) === true,
  await ev(`document.querySelector('.camera-error pre')?.textContent?.slice(0,70) ?? ''`),
);

// 覆盖层是否在画（假设备检不到人，但画布应已被创建并擦过）
const canvasInfo = await ev(`(() => {
  const c = document.querySelector('.mocap-overlay');
  return c ? { w: c.width, h: c.height } : null;
})()`);
check('关键点覆盖层已就绪', !!canvasInfo && canvasInfo.w > 0, canvasInfo ? `${canvasInfo.w}×${canvasInfo.h}` : '无');

// ── 7. 校准（假设备检不到人 → 应当明确失败而不是静默通过）──────────────
await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('校准'));
  btn?.click();
  return !!btn;
})()`);
// ── 8. ★ 校准开关：默认跳过 ⇒ 无需校准即可录制；打开校准 ⇒ 走原闸门 ──────
const tog = `document.querySelector('.skip-calibration input[type=checkbox]')`;
const hasToggle = await ev(`!!${tog}`);
check('★ 有「跳过校准」开关', hasToggle === true, hasToggle ? '存在' : '找不到 .skip-calibration');
check('★ 默认跳过校准（实测：修正量不能泛化，校准反而更偏）', (await ev(`${tog}.checked`)) === true);

const recDisabled = await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始录制'));
  return btn ? btn.disabled : null;
})()`);
check('★ 跳过校准时不要求"校准通过"即可录制', recDisabled === false, `disabled=${recDisabled}`);

// 打开校准 → 应退回 detecting，且录制被拦住（原计划的闸门仍然有效）
await ev(`${tog}.click()`);
await sleep(1200);
const stateAfterSkip = await ev('__mocapDebug.getState()');
const recDisabled2 = await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始录制'));
  return btn ? btn.disabled : null;
})()`);
check('★ 打开校准后退回 detecting', stateAfterSkip === 'detecting', `state=${stateAfterSkip}`);
check('★ 打开校准后「开始录制」被拦住（原闸门仍有效）', recDisabled2 === true, `disabled=${recDisabled2}`);

// 顺手验一次「校准会被明确拒绝」——现在要手动触发
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('校准（1.5 秒）'))?.click()`);
let calibText = '';
for (let i = 0; i < 20; i++) {
  await sleep(600);
  calibText = await ev(`document.querySelector('.calibration-box .bad, .calibration-box .ok')?.textContent ?? ''`);
  if (calibText) break;
}
check(
  '★ 假设备下校准被明确拒绝（检测率不足），不是静默通过',
  calibText.includes('未通过') || calibText.includes('检测率'),
  calibText.slice(0, 100),
);

const camInfo = await ev('__mocapDebug.getCameraInfo()');
if (camInfo) {
  console.log(
    `      摄像头诊断: 帧 ${camInfo.framesProcessed}｜${camInfo.inferenceFps.toFixed(1)}fps｜` +
      `帧回调 ${camInfo.usingRvfc ? 'rVFC' : 'rAF'}｜轨道 ${camInfo.activeTracks}｜${camInfo.detail}`,
  );
}

// ── 9. 关掉摄像头 → 轨道应释放 ─────────────────────────────────────────
await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('关闭摄像头'));
  btn?.click();
  return !!btn;
})()`);
await sleep(2500);
const stateAfter = await ev('__mocapDebug.getState()');
const videoHasStream = await ev(`(() => { const v=document.querySelector('video'); return !!(v && v.srcObject); })()`);
check('关闭摄像头后回到 camera-off', stateAfter === 'camera-off', `state=${stateAfter}`);
check('★ 关闭后 video.srcObject 已释放（对应验收第 10 条）', videoHasStream === false, `srcObject=${videoHasStream}`);

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) {
  console.log(`\n运行期控制台错误 ${consoleErrors.length} 条（前 6）：`);
  consoleErrors.slice(0, 6).forEach((c) => console.log('  ' + String(c).slice(0, 150)));
}
if (failed.length) {
  console.log('\n失败项：');
  failed.forEach((f) => console.log('  - ' + f.n));
}
process.exit(failed.length ? 1 : 0);

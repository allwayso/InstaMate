#!/usr/bin/env node
/**
 * 把 @mediapipe/holistic 里运行时真正需要的文件复制到 web/public/vendor/mediapipe/holistic/。
 *
 * 为什么需要这个脚本
 * ------------------
 * MediaPipe 的 JS 方案不是普通的 npm 导入：`@mediapipe/holistic/holistic.js` 会在运行时
 * 按 `locateFile()` 返回的 URL 去**动态抓取** wasm、tflite 模型和 graph 文件。
 * 默认实现是相对于当前页面路径去找（`window.location.pathname`），在 Next.js 下必然 404，
 * 而 MediaPipe 对失败的表现是**卡住而不是报错**，非常难查。
 *
 * 所以：把文件复制进 public/，并让 `locateFile` 恒定返回 `/vendor/mediapipe/holistic/<file>`。
 * 同时提供 `--check`，让页面启动前能明确报错「缺哪个文件」，而不是静默失败。
 *
 * 文件清单在 `web/lib/mocap/mediapipe-manifest.json`，与浏览器自检共享。
 * 使用 JSON 避免启动钩子依赖 Node 22+ 才提供的 TypeScript 直接执行能力。
 */
import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'web/lib/mocap/mediapipe-manifest.json'), 'utf8'));
const PINNED_VERSION = manifest.version;
const MEDIAPIPE_PACKAGE_DIR = manifest.packageDir;
const VENDOR_DIR = manifest.vendorDir;
const SRC_DIR = join(ROOT, MEDIAPIPE_PACKAGE_DIR);
const OUT_DIR = join(ROOT, VENDOR_DIR);
const REQUIRED = [...manifest.directFiles, ...manifest.loaderFiles];
const SKIPPED = manifest.skippedFiles;

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');
const asJson = args.includes('--json');
const log = asJson ? () => {} : (...a) => console.log(...a);

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

function readPkgVersion() {
  const p = join(SRC_DIR, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 收集状态：不复制，只报告。`--check` 与页面自检用同一口径。 */
function inspect() {
  const files = [];
  for (const name of REQUIRED) {
    const src = join(SRC_DIR, name);
    const dest = join(OUT_DIR, name);
    files.push({
      name,
      srcExists: existsSync(src),
      destExists: existsSync(dest),
      srcBytes: existsSync(src) ? statSync(src).size : 0,
      destBytes: existsSync(dest) ? statSync(dest).size : 0,
    });
  }
  return files;
}

function report(ok, files, note) {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok,
          source: MEDIAPIPE_PACKAGE_DIR,
          outDir: VENDOR_DIR,
          version: { expected: PINNED_VERSION, found: readPkgVersion() },
          required: REQUIRED,
          skipped: SKIPPED,
          files,
          note,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const f of files) {
    const state = !f.destExists
      ? '缺少'
      : !force && f.srcExists && f.srcBytes !== f.destBytes
        ? '大小不符'
        : '就位';
    const mark = state === '就位' ? '✓' : '✗';
    log(`  ${mark} ${f.name.padEnd(42)} ${state}${f.destExists ? `  ${mb(f.destBytes)}` : ''}`);
  }
  if (note) log(`\n${note}`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────

if (!existsSync(SRC_DIR)) {
  console.error('找不到 @mediapipe/holistic。请先在 web/ 下执行：');
  console.error('  npm install @mediapipe/holistic@' + PINNED_VERSION + ' --save-exact');
  process.exit(2);
}

const foundVersion = readPkgVersion();
if (foundVersion !== PINNED_VERSION) {
  console.error(`@mediapipe/holistic 版本不符：期望 ${PINNED_VERSION}，实际 ${foundVersion ?? '未知'}`);
  console.error('版本漂移会改变 wasm 与模型文件名，必须先锁回来再同步。');
  process.exit(2);
}

if (checkOnly) {
  const files = inspect();
  const missing = files.filter((f) => !f.destExists).map((f) => f.name);
  const sizeMismatch = files.filter((f) => f.destExists && f.srcExists && f.srcBytes !== f.destBytes).map((f) => f.name);
  const ok = missing.length === 0 && sizeMismatch.length === 0;
  if (!asJson) {
    log('检查 MediaPipe Holistic 本地资源（web/public/vendor/mediapipe/holistic/）');
    log(`  版本 ${foundVersion}\n`);
  }
  report(ok, files, ok ? '本地资源齐全。' : '存在缺失或大小不符，请执行：node tools/sync-mediapipe.mjs');
  process.exit(ok ? 0 : 1);
}

mkdirSync(OUT_DIR, { recursive: true });

// 先把源文件全部校验一遍，再开始复制 —— 避免复制到一半失败留下半个 vendor 目录
const missingSrc = REQUIRED.filter((n) => !existsSync(join(SRC_DIR, n)));
if (missingSrc.length) {
  console.error('npm 包缺少以下文件，中止同步（不做部分复制）：');
  for (const n of missingSrc) console.error(`  - ${n}`);
  console.error('请确认 @mediapipe/holistic 版本与安装完整性。');
  process.exit(1);
}

const before = inspect();
const toCopy = before.filter(
  (f) => force || !f.destExists || (f.srcExists && f.srcBytes !== f.destBytes),
);

log('同步 MediaPipe Holistic 本地资源');
log(`  源   ${MEDIAPIPE_PACKAGE_DIR}  (v${foundVersion})`);
log(`  目标 ${VENDOR_DIR}/`);
log(`  需要 ${REQUIRED.length} 个文件，本次需复制 ${toCopy.length} 个\n`);

for (const f of toCopy) {
  copyFileSync(join(SRC_DIR, f.name), join(OUT_DIR, f.name));
  log(`  复制 ${f.name.padEnd(42)} ${mb(f.srcBytes)}`);
}

const after = inspect();
const missing = after.filter((f) => !f.destExists);
const mismatched = after.filter((f) => f.destExists && f.srcExists && f.srcBytes !== f.destBytes);
const totalBytes = after.reduce((s, f) => s + f.destBytes, 0);

if (missing.length || mismatched.length) {
  report(false, after, '同步后仍有问题，请检查磁盘空间与权限。');
  process.exit(1);
}

log(`\n  共 ${after.length} 个文件，合计 ${mb(totalBytes)}`);
if (toCopy.length === 0) log('  （已是最新，未做复制）');
log('\n刻意未复制：');
for (const s of SKIPPED) log(`  - ${s.file}（${s.reason}）`);
log('\n本地资源齐全。');

if (!asJson) {
  const extras = readdirSync(OUT_DIR).filter((n) => !REQUIRED.includes(n));
  if (extras.length) log(`\n注意：目录里还有清单外的文件：${extras.join(', ')}`);
}

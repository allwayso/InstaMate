#!/usr/bin/env node
/**
 * 照片 → 清洗背景的 T-pose 平面图 → （用户确认后）建模/贴图/绑骨 → VRM
 *
 * 为什么拆成两段跑（而不是一口气跑完）：
 *
 *   Tripo 的阶段②（generate_image / template=t_pose）只花 5 积分，
 *   但它决定了后面所有东西长什么样 —— 一旦背景清洗得不对、或者人物被换掉了，
 *   后面的建模(40)+贴图(20)+绑骨(25) 全是白花的。
 *
 *   所以跑到阶段②就停下，把那 5 积分的平面图给用户看，让他选：
 *       继续生成 / 更换输入图片 / 放弃
 *   这不是"多一步确认"，而是**在花钱之前把判据交到能判断的人手里**。
 *
 * 用法：
 *   node tools/avatar-job.mjs <jobId> ref    只跑到阶段②，然后停在 awaiting_continue
 *   node tools/avatar-job.mjs <jobId> full   接着跑建模/贴图/绑骨/VRM
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(repo, 'web');
const jobsRoot = resolve(process.env.AVATAR_JOBS_DIR ?? join(repo, 'data', 'avatar-jobs'));
const id = process.argv[2];
const stage = process.argv[3] ?? 'ref';
if (!/^[0-9a-f]{32}$/.test(id ?? '')) process.exit(2);
if (!['ref', 'full'].includes(stage)) process.exit(2);
const dir = join(jobsRoot, id);
const jobPath = join(dir, 'job.json');

async function readJob() {
  return JSON.parse(await readFile(jobPath, 'utf8'));
}
async function update(fields) {
  const job = { ...(await readJob()), ...fields, updated_at: new Date().toISOString() };
  const temporary = jobPath + '.tmp';
  await writeFile(temporary, JSON.stringify(job, null, 2), 'utf8');
  await rename(temporary, jobPath);
}

/**
 * 跑一个子进程，把输出尾巴留着当错误信息。
 *
 * ★ child 拿出来登记，是为了让「放弃」能真的把进程杀掉。
 *   只 kill 自己没用 —— 真正在烧积分的是它启动的 python 子进程。
 */
const running = new Set();
async function run(command, args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    running.add(child);
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { tail = (tail + chunk.toString()).slice(-5000); });
    }
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 20 * 60_000);
    child.on('error', rejectRun);
    child.on('close', (code) => {
      running.delete(child);
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else rejectRun(new Error(tail.trim() || command + ' exited with ' + code));
    });
  });
}

/**
 * 跑一个"会产出文件"的步骤，**以产物为准判定成功**。
 *
 * 为什么不能只等 close 事件：Windows 上实测到过子进程写完文件却不退出 ——
 * CPU 只用了 0.2 秒、产物 15 MB 已完整、进程却挂在那里不动。
 * 只等 close 的话，这一步会白等 45 分钟超时，用户看到的是"卡住了"。
 *
 * 所以这里的判据是：产物出现、并且连续两次大小不变（写完了），就算成功；
 * 然后主动把子进程收掉。子进程正常退出当然也认。
 */
async function runUntilOutput(command, args, environment, outputPath, timeoutMs) {
  const started = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    running.add(child);
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { tail = (tail + chunk.toString()).slice(-5000); });
    }
    let lastSize = -1;
    const poll = setInterval(() => {
      let size = -1;
      try { size = statSync(outputPath).size; } catch { return; }
      // 大小稳定才算写完：15 MB 的 GLB 可能一次写不完
      if (size > 0 && size === lastSize) {
        clearInterval(poll); clearTimeout(deadline);
        child.kill('SIGTERM');
        resolveRun();
      }
      lastSize = size;
    }, 1000);
    const deadline = setTimeout(() => {
      clearInterval(poll); child.kill('SIGTERM');
      rejectRun(new Error(tail.trim() || `超过 ${Math.round(timeoutMs / 1000)} 秒没有产出`));
    }, timeoutMs);
    child.on('error', (error) => { clearInterval(poll); clearTimeout(deadline); rejectRun(error); });
    child.on('close', (code) => {
      running.delete(child);
      clearInterval(poll); clearTimeout(deadline);
      if (code === 0 || existsSync(outputPath)) resolveRun();
      else rejectRun(new Error(tail.trim() || command + ' exited with ' + code));
    });
    if (process.env.AVATAR_JOB_TRACE) console.log(`  [trace] 启动 ${command.split(/[\/]/).pop()} 等 ${Math.round(timeoutMs/1000)}s`);
    void started;
  });
}

/** 被要求放弃时，先在途的子进程收干净，再退出。 */
let cancelled = false;
async function bail(reason) {
  cancelled = true;
  for (const child of running) child.kill('SIGTERM');
  await update({ status: 'cancelled', stage: '已放弃', error: reason }).catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => { void bail('已放弃'); });
process.on('SIGINT', () => { void bail('已放弃'); });

async function main() {
  const job = await readJob();
  const venvPython = process.platform === 'win32'
    ? join(repo, 'memory', '.venv', 'Scripts', 'python.exe')
    : join(repo, 'memory', '.venv', 'bin', 'python');
  const pythonExe = process.env.TRIPO_PYTHON
    ?? (existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3');

  const prompt = [
    'Transform the reference person into a polished anime character.',
    'Keep facial identity, hair and recognizable clothing colors.',
    job.style === 'chibi' ? 'Use a chibi anime style with a full human-compatible body.' :
      job.style === 'soft' ? 'Use a soft hand-painted anime illustration style.' :
        'Use a clean Japanese anime character style.',
    'Full body from head to toe, strict T-pose, straight horizontal arms, palms down, legs slightly apart.',
    'Facing camera, plain neutral background, no cropped limbs, one person only.',
    'Completely clean background: remove the original background, no stage, no furniture, no props, no other people.',
  ].join(' ');
  const environment = {
    ...process.env,
    TRIPO_IMAGE_PROMPT: prompt,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  const pipeline = join(repo, 'tripo', 'tpose_pipeline.py');

  // ── 第一段：只跑到阶段②（背景清洗 + T-pose 平面图），5 积分 ────────────
  await update({
    status: 'running', stage: '清洗背景并生成 T-pose 平面图', pid: process.pid, error: null,
  });
  await run(pythonExe, [
    pipeline, '--run', dir, '--image', join(dir, job.image_name), '--upto', 'ref',
  ], environment);
  if (cancelled) return;

  if (stage === 'ref') {
    await update({
      status: 'awaiting_continue',
      stage: '平面图已生成，等待你确认',
      preview_url: '/api/avatar-jobs/' + id + '/reference',
      pid: null,
    });
    return;
  }

  // ── 第二段：建模 / 贴图 / 绑骨 / 转 VRM（用户确认之后）────────────────
  await update({ stage: '建模、贴图与绑骨', pid: process.pid });
  await run(pythonExe, [pipeline, '--run', dir, '--upto', 'rig'], environment);
  if (cancelled) return;

  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const glb = (state.rigged_files ?? []).find(
    (item) => typeof item === 'string' && item.toLowerCase().endsWith('.glb'));
  if (!glb) throw new Error('Tripo 没有返回绑骨 GLB，请检查任务结果');
  const input = resolve(glb);
  // ★ 不能用 startsWith(dir + '/')：Windows 的 path 用反斜杠，那个写法恒为 false，
  //   于是**正确的路径也会被拦下**，报“绑骨模型路径不在当前任务目录”。
  //   实测（win32）：目录内 旧写法 false ❌ / relative() true ✅
  //   顺带 relative 也挡住了 ".." 逃逸与跨盘符。
  const rel = relative(dir, input);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('绑骨模型路径不在当前任务目录');
  }

  const output = join(web, 'public', 'avatars', id + '.vrm');
  const temporary = join(web, 'public', 'avatars', id + '.tmp.vrm');
  await update({ stage: '转换并验证 VRM' });
  try {
    await runUntilOutput(process.execPath, [
      join(repo, 'tools', 'gltf-to-vrm.mjs'), input, '-o', temporary,
      '--name', job.name, '--height', '1.75',
    ], process.env, temporary, 10 * 60_000);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  await update({
    status: 'complete', stage: '完成', pid: null,
    avatar_url: '/avatars/' + id + '.vrm',
    preview_url: '/api/avatar-jobs/' + id + '/reference',
  });
}

main().catch(async (error) => {
  if (cancelled) return;
  await update({
    status: 'failed', stage: '失败', pid: null,
    error: (error instanceof Error ? error.message : String(error)).slice(-1000),
  }).catch(() => undefined);
  process.exitCode = 1;
});

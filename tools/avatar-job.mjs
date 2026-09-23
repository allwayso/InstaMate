#!/usr/bin/env node
/**
 * 两种本机图片流程：
 *   阿里百炼：照片 → 动漫 T-pose 参考图 → 用户确认 → Tripo 3D → VRM
 *   Tripo：照片 → 5 积分 T-pose 平面图 → 用户确认 → Tripo 3D → VRM
 *
 * 用法：
 *   node tools/avatar-job.mjs <jobId> image  阿里百炼图片阶段
 *   node tools/avatar-job.mjs <jobId> model  阿里百炼任务的 Tripo 3D 阶段
 *   node tools/avatar-job.mjs <jobId> ref    Tripo 平面图阶段
 *   node tools/avatar-job.mjs <jobId> full   Tripo 平面图任务的 3D 阶段
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAnimeReference } from './aliyun-image.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(repo, 'web');
const jobsRoot = resolve(process.env.AVATAR_JOBS_DIR ?? join(repo, 'data', 'avatar-jobs'));
const id = process.argv[2];
const stage = process.argv[3] ?? 'image';
if (!/^[0-9a-f]{32}$/.test(id ?? '')) process.exit(2);
if (!['image', 'model', 'ref', 'full'].includes(stage)) process.exit(2);
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
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
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
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
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
  if (job.status === 'cancelled') return;
  const python = process.env.TRIPO_PYTHON
    ?? (existsSync(join(repo, 'memory', '.venv', 'bin', 'python'))
      ? join(repo, 'memory', '.venv', 'bin', 'python') : 'python3');
  // Windows 上 venv 的解释器在 Scripts\ 下；上面那个 bin/ 是 POSIX 布局。
  const pythonExe = existsSync(python)
    ? python
    : existsSync(join(repo, 'memory', '.venv', 'Scripts', 'python.exe'))
      ? join(repo, 'memory', '.venv', 'Scripts', 'python.exe')
      : python;

  const prompt = [
    '以输入照片中的同一个人为原型，只生成一张单人全身动漫立绘，用于后续 3D 建模。整张图片只出现这一个人物、一个正面视角、一个姿势。',
    '保留五官身份特征、发型、发色、服装款式和主要颜色，不要改变年龄感。',
    job.style === 'chibi' ? '采用 Q 版动漫画风，但保持清晰完整的人体四肢和手指。' :
      job.style === 'soft' ? '采用柔和的手绘动漫画风。' : '采用干净的日系动漫赛璐璐画风。',
    '人物居中、正面面向镜头，摆严格对称的 T-pose：双臂在肩高水平伸直，双手与身体分开，手掌朝下，双腿直立且略微分开。头顶、双手和鞋底都完整入镜，人物尽可能占满画面，同时在四周留少量空白。',
    '纯浅色背景，均匀光照。不要角色设定板、三视图或多格拼版；不要侧面和背面视图、头部特写、重复人物、文字标注、色卡、道具或多余的肢体。',
  ].join(' ');
  const environment = {
    ...process.env,
    TRIPO_IMAGE_PROMPT: prompt,
    PYTHONUNBUFFERED: '1',
  };
  const pipeline = join(repo, 'tripo', 'tpose_pipeline.py');

  if (stage === 'image') {
    await update({ status: 'running', stage: '阿里百炼正在生成动漫 T-pose 参考图', pid: process.pid, error: null });
    await generateAnimeReference({
      inputPath: join(dir, job.image_name), runDir: dir,
      provider: process.env.ALIYUN_IMAGE_PROVIDER,
      model: process.env.ALIYUN_IMAGE_MODEL,
      baseUrl: process.env.DASHSCOPE_BASE_URL,
      apiKey: process.env.DASHSCOPE_API_KEY,
      prompt,
    });
    if (cancelled) return;
    await update({ status: 'image-ready', stage: '动漫参考图已生成，确认后可继续生成 3D',
      preview_url: '/api/avatar-jobs/' + id + '/reference', pid: null });
    return;
  }

  if (stage === 'ref') {
    await update({ status: 'running', stage: '清洗背景并生成 T-pose 平面图', pid: process.pid, error: null });
    await run(pythonExe, [
      pipeline, '--run', dir, '--image', join(dir, job.image_name), '--upto', 'ref',
    ], environment);
    if (cancelled) return;
    await update({
      status: 'awaiting_continue',
      stage: '平面图已生成，等待你确认',
      preview_url: '/api/avatar-jobs/' + id + '/reference',
      pid: null,
    });
    return;
  }

  // 两种参考图都由用户确认后进入同一套 3D 建模管线。
  await update({ status: 'running', stage: '建模、贴图与绑骨', pid: process.pid, error: null });
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

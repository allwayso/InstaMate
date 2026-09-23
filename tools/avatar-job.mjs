#!/usr/bin/env node
/** Long-running local photo → anime T-pose → rigged GLB → VRM job. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAnimeReference } from './aliyun-image.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(repo, 'web');
const jobsRoot = resolve(process.env.AVATAR_JOBS_DIR ?? join(repo, 'data', 'avatar-jobs'));
const id = process.argv[2];
const phase = process.argv[3] ?? 'image';
if (!/^[0-9a-f]{32}$/.test(id ?? '')) process.exit(2);
if (!['image', 'model'].includes(phase)) process.exit(2);
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
async function run(command, args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { tail = (tail + chunk.toString()).slice(-5000); });
    }
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 45 * 60_000);
    child.on('error', rejectRun);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else rejectRun(new Error(tail.trim() || command + ' exited with ' + code));
    });
  });
}

try {
  const job = await readJob();
  const prompt = [
    '以输入照片中的同一个人为原型，生成可用于 3D 建模的单人全身动漫角色参考图。',
    '保留五官身份特征、发型、发色、服装款式和主要颜色，不要改变年龄感。',
    job.style === 'chibi' ? '采用 Q 版动漫画风，但保持清晰完整的人体四肢和手指。' :
      job.style === 'soft' ? '采用柔和的手绘动漫画风。' : '采用干净的日系动漫赛璐璐画风。',
    '让人物正面面向镜头，完整从头到脚入镜，摆严格对称的 T-pose：双臂在肩高水平伸直，双手与身体分开，手掌朝下，双腿直立且略微分开。',
    '纯浅色背景，均匀光照，无道具，不裁切任何部位，不要多余的手臂或腿。',
  ].join(' ');
  if (phase === 'image') {
    await update({ status: 'running', stage: '阿里百炼正在生成动漫 T-pose 参考图' });
    await generateAnimeReference({
      inputPath: join(dir, job.image_name),
      runDir: dir,
      provider: process.env.ALIYUN_IMAGE_PROVIDER,
      model: process.env.ALIYUN_IMAGE_MODEL,
      baseUrl: process.env.DASHSCOPE_BASE_URL,
      apiKey: process.env.DASHSCOPE_API_KEY,
      prompt,
    });
    await update({ status: 'image-ready', stage: '动漫参考图已生成，确认后可继续生成 3D',
      preview_url: '/api/avatar-jobs/' + id + '/reference' });
  } else {
    const python = process.env.TRIPO_PYTHON
      ?? (existsSync(join(repo, 'memory', '.venv', 'bin', 'python'))
        ? join(repo, 'memory', '.venv', 'bin', 'python') : 'python3');
    const pipeline = join(repo, 'tripo', 'tpose_pipeline.py');
    await update({ stage: 'Tripo 建模、贴图与绑骨' });
    await run(python, [pipeline, '--run', dir, '--upto', 'rig'], { ...process.env, PYTHONUNBUFFERED: '1' });
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    const glb = (state.rigged_files ?? []).find((item) => typeof item === 'string' && item.toLowerCase().endsWith('.glb'));
    if (!glb) throw new Error('Tripo 没有返回绑骨 GLB，请检查任务结果');
    const input = resolve(glb);
    if (!input.startsWith(dir + '/')) throw new Error('绑骨模型路径不在当前任务目录');
    const output = join(web, 'public', 'avatars', id + '.vrm');
    const temporary = join(web, 'public', 'avatars', id + '.tmp.vrm');
    await update({ stage: '转换并验证 VRM' });
    try {
      await run(process.execPath, [
        join(repo, 'tools', 'gltf-to-vrm.mjs'), input, '-o', temporary,
        '--name', job.name, '--height', '1.75',
      ], process.env);
      await rename(temporary, output);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await update({
      status: 'complete', stage: '完成',
      avatar_url: '/avatars/' + id + '.vrm',
      preview_url: '/api/avatar-jobs/' + id + '/reference',
    });
  }
} catch (error) {
  await update({
    status: 'failed', stage: '失败',
    error: (error instanceof Error ? error.message : String(error)).slice(-1000),
  }).catch(() => undefined);
  process.exitCode = 1;
}

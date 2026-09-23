#!/usr/bin/env node
/** Long-running local photo → anime T-pose → rigged GLB → VRM job. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(repo, 'web');
const jobsRoot = resolve(process.env.AVATAR_JOBS_DIR ?? join(repo, 'data', 'avatar-jobs'));
const id = process.argv[2];
if (!/^[0-9a-f]{32}$/.test(id ?? '')) process.exit(2);
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
  const python = process.env.TRIPO_PYTHON
    ?? (existsSync(join(repo, 'memory', '.venv', 'bin', 'python'))
      ? join(repo, 'memory', '.venv', 'bin', 'python') : 'python3');
  const prompt = [
    'Transform the reference person into a polished anime character.',
    'Keep facial identity, hair and recognizable clothing colors.',
    job.style === 'chibi' ? 'Use a chibi anime style with a full human-compatible body.' :
      job.style === 'soft' ? 'Use a soft hand-painted anime illustration style.' :
        'Use a clean Japanese anime character style.',
    'Full body from head to toe, strict T-pose, straight horizontal arms, palms down, legs slightly apart.',
    'Facing camera, plain neutral background, no cropped limbs, one person only.',
  ].join(' ');
  const environment = {
    ...process.env,
    TRIPO_IMAGE_PROMPT: prompt,
    PYTHONUNBUFFERED: '1',
  };
  const pipeline = join(repo, 'tripo', 'tpose_pipeline.py');
  await update({ status: 'running', stage: '动漫化与 T-pose 参考图' });
  await run(python, [pipeline, '--run', dir, '--image', join(dir, job.image_name), '--upto', 'ref'], environment);
  await update({ stage: 'Tripo 建模、贴图与绑骨' });
  await run(python, [pipeline, '--run', dir, '--upto', 'rig'], environment);
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
} catch (error) {
  await update({
    status: 'failed', stage: '失败',
    error: (error instanceof Error ? error.message : String(error)).slice(-1000),
  }).catch(() => undefined);
  process.exitCode = 1;
}

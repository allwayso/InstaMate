import { lstat, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export interface AvatarJob {
  id: string;
  name: string;
  style: 'anime' | 'soft' | 'chibi';
  image_name: string;
  image_provider?: 'qwen' | 'wanx';
  image_model?: string;
  generation_mode?: 'aliyun' | 'tripo';
  status: 'queued' | 'running' | 'image-ready' | 'awaiting_continue' | 'complete' | 'failed' | 'cancelled';
  stage: string;
  error?: string | null;
  avatar_url?: string;
  preview_url?: string;
  pid?: number | null;
  created_at: string;
  updated_at: string;
}

export const AVATAR_JOBS_ROOT = process.env.AVATAR_JOBS_DIR
  ? resolve(/* turbopackIgnore: true */ process.env.AVATAR_JOBS_DIR)
  : resolve(process.cwd(), '..', 'data', 'avatar-jobs');

export const avatarJobDir = (id: string) => join(AVATAR_JOBS_ROOT, id);
export const validAvatarJobId = (id: string) => /^[0-9a-f]{32}$/.test(id);

export function avatarGenerationMode(job: AvatarJob): 'aliyun' | 'tripo' {
  return job.generation_mode ?? (job.image_provider ? 'aliyun' : 'tripo');
}

export function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export async function readAvatarJob(id: string, jobsRoot: string = AVATAR_JOBS_ROOT): Promise<AvatarJob | null> {
  if (!validAvatarJobId(id)) return null;
  try {
    const job = JSON.parse(await readFile(join(jobsRoot, id, 'job.json'), 'utf8')) as AvatarJob;
    job.generation_mode = avatarGenerationMode(job);
    if (await referencePath(id, jobsRoot)) job.preview_url = '/api/avatar-jobs/' + id + '/reference';
    else delete job.preview_url;
    return job;
  } catch {
    return null;
  }
}

export async function listAvatarJobs(): Promise<AvatarJob[]> {
  let names: string[];
  try { names = await readdir(AVATAR_JOBS_ROOT); }
  catch { return []; }
  const jobs = await Promise.all(names.filter(validAvatarJobId).map((id) => readAvatarJob(id)));
  return jobs.filter((job): job is AvatarJob => job !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function referencePath(id: string, jobsRoot: string = AVATAR_JOBS_ROOT): Promise<string | null> {
  if (!validAvatarJobId(id)) return null;
  try {
    const dir = await realpath(join(jobsRoot, id));
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
      tpose_ref_image?: string;
    };
    if (!state.tpose_ref_image) return null;
    const image = await realpath(state.tpose_ref_image);
    if (!isInsideDirectory(dir, image)) return null;
    if (!/\.(png|jpe?g|webp)$/i.test(image)) return null;
    return image;
  } catch { return null; }
}

export type DeleteAvatarJobResult = 'deleted' | 'not-found' | 'active' | 'busy';

/** Only the id-derived job directory and VRM filenames may be removed. Roots are injectable for offline tests. */
export async function deleteFinishedAvatarJob(
  id: string,
  roots: { jobsRoot?: string; avatarsRoot?: string } = {},
): Promise<DeleteAvatarJobResult> {
  if (!validAvatarJobId(id)) return 'not-found';
  const jobsRoot = resolve(roots.jobsRoot ?? AVATAR_JOBS_ROOT);
  const avatarsRoot = resolve(roots.avatarsRoot ?? join(process.cwd(), 'public', 'avatars'));
  const dir = join(jobsRoot, id);

  const rootInfo = await lstat(jobsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootInfo) return 'not-found';
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('任务根目录不安全');
  const rootReal = await realpath(jobsRoot);
  const dirInfo = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!dirInfo) return 'not-found';
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || await realpath(dir) !== join(rootReal, id)) {
    throw new Error('任务目录不安全');
  }

  const lockPath = join(dir, '.delete.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not-found';
    throw error;
  }
  let movedTo: string | null = null;
  try {
    if (await realpath(dir) !== join(rootReal, id)) throw new Error('任务目录已变化');
    const modelLock = await lstat(join(dir, '.model-start.lock')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (modelLock) return 'busy';

    const jobFile = join(dir, 'job.json');
    const jobInfo = await lstat(jobFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!jobInfo) return 'not-found';
    if (!jobInfo.isFile() || jobInfo.isSymbolicLink() || await realpath(jobFile) !== join(rootReal, id, 'job.json')) {
      throw new Error('任务记录文件不安全');
    }
    const job = JSON.parse(await readFile(jobFile, 'utf8')) as AvatarJob;
    if (job.id !== id) throw new Error('任务记录 ID 不匹配');
    if (job.status === 'queued' || job.status === 'running') return 'active';
    if (!['image-ready', 'awaiting_continue', 'complete', 'failed', 'cancelled'].includes(job.status)) {
      throw new Error('任务状态不合法');
    }

    // Do not trust avatar_url from job.json; generated files have fixed id-derived names.
    const avatarRootInfo = await lstat(avatarsRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (avatarRootInfo && (!avatarRootInfo.isDirectory() || avatarRootInfo.isSymbolicLink())) {
      throw new Error('VRM 目录不安全');
    }
    const avatarFiles = [join(avatarsRoot, `${id}.vrm`), join(avatarsRoot, `${id}.tmp.vrm`)];
    for (const path of avatarFiles) {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('VRM 文件不安全');
    }

    // Rename first so the worker and readers cannot find this job while files are removed.
    const tombstoneName = `.deleting-${id}-${randomUUID()}`;
    const tombstone = join(jobsRoot, tombstoneName);
    await rename(dir, tombstone);
    movedTo = tombstone;
    const tombstoneInfo = await lstat(tombstone);
    if (!tombstoneInfo.isDirectory() || tombstoneInfo.isSymbolicLink() ||
        await realpath(tombstone) !== join(rootReal, tombstoneName)) {
      throw new Error('待删除目录不安全');
    }
    for (const path of avatarFiles) await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rm(tombstone, { recursive: true, force: false });
    movedTo = null;
    return 'deleted';
  } catch (error) {
    if (movedTo) await rename(movedTo, dir).catch(() => undefined);
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function deleteAllFinishedAvatarJobs(
  roots: { jobsRoot?: string; avatarsRoot?: string; generationMode?: 'aliyun' | 'tripo' } = {},
): Promise<{ deletedIds: string[]; skippedIds: string[] }> {
  const jobsRoot = resolve(roots.jobsRoot ?? AVATAR_JOBS_ROOT);
  const rootInfo = await lstat(jobsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootInfo) return { deletedIds: [], skippedIds: [] };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('任务根目录不安全');
  const names = (await readdir(jobsRoot)).filter(validAvatarJobId);
  const deletedIds: string[] = [];
  const skippedIds: string[] = [];
  for (const id of names) {
    try {
      if (roots.generationMode) {
        const job = await readAvatarJob(id, jobsRoot);
        if (!job || avatarGenerationMode(job) !== roots.generationMode) continue;
      }
      const result = await deleteFinishedAvatarJob(id, roots);
      if (result === 'deleted') deletedIds.push(id);
      else if (result !== 'not-found') skippedIds.push(id);
    } catch {
      skippedIds.push(id);
    }
  }
  return { deletedIds, skippedIds };
}

export async function writeJobFields(id: string, fields: Partial<AvatarJob>): Promise<void> {
  if (!validAvatarJobId(id)) throw new Error('任务 ID 不合法');
  const path = join(avatarJobDir(id), 'job.json');
  const current = JSON.parse(await readFile(path, 'utf8')) as AvatarJob;
  const next = { ...current, ...fields, updated_at: new Date().toISOString() };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

const execFileAsync = promisify(execFile);

export async function killAvatarJobTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      process.kill(-pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

export async function spawnAvatarJob(
  id: string, stage: 'ref' | 'full', env: Record<string, string | undefined>,
): Promise<number | undefined> {
  if (!validAvatarJobId(id)) throw new Error('任务 ID 不合法');
  const repo = resolve(process.cwd(), '..');
  const { spawn } = await import('node:child_process');
  const workerEnv = { ...process.env, ...env };
  delete workerEnv.DASHSCOPE_API_KEY;
  delete workerEnv.DASHSCOPE_BASE_URL;
  delete workerEnv.DASHSCOPE_WS_URL;
  const child = spawn(process.execPath, [join(repo, 'tools', 'avatar-job.mjs'), id, stage], {
    cwd: repo, env: workerEnv, detached: true, stdio: 'ignore',
  });
  await new Promise<void>((done, failed) => {
    child.once('spawn', done);
    child.once('error', failed);
  });
  child.unref();
  return child.pid;
}

export async function resetAvatarJobState(id: string): Promise<void> {
  if (!validAvatarJobId(id)) throw new Error('任务 ID 不合法');
  const dir = avatarJobDir(id);
  await rm(join(dir, 'state.json'), { force: true });
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (/^0[0-9]_/.test(name) || /^[123][0-9]_/.test(name)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

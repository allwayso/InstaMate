import { lstat, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export interface AvatarJob {
  id: string;
  name: string;
  style: 'anime' | 'soft' | 'chibi';
  image_name: string;
  image_provider?: 'qwen' | 'wanx';
  image_model?: string;
  status: 'queued' | 'running' | 'image-ready' | 'complete' | 'failed';
  stage: string;
  error?: string;
  avatar_url?: string;
  preview_url?: string;
  created_at: string;
  updated_at: string;
}

export const AVATAR_JOBS_ROOT = process.env.AVATAR_JOBS_DIR
  ? resolve(/* turbopackIgnore: true */ process.env.AVATAR_JOBS_DIR)
  : resolve(process.cwd(), '..', 'data', 'avatar-jobs');

export const avatarJobDir = (id: string) => join(AVATAR_JOBS_ROOT, id);
export const validAvatarJobId = (id: string) => /^[0-9a-f]{32}$/.test(id);

export async function readAvatarJob(id: string, jobsRoot: string = AVATAR_JOBS_ROOT): Promise<AvatarJob | null> {
  if (!validAvatarJobId(id)) return null;
  try {
    const job = JSON.parse(await readFile(join(jobsRoot, id, 'job.json'), 'utf8')) as AvatarJob;
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
    if (!image.startsWith(dir + '/')) return null;
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
    if (!['image-ready', 'complete', 'failed'].includes(job.status)) throw new Error('任务状态不合法');

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
  roots: { jobsRoot?: string; avatarsRoot?: string } = {},
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
      const result = await deleteFinishedAvatarJob(id, roots);
      if (result === 'deleted') deletedIds.push(id);
      else if (result !== 'not-found') skippedIds.push(id);
    } catch {
      skippedIds.push(id);
    }
  }
  return { deletedIds, skippedIds };
}

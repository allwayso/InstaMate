import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface AvatarJob {
  id: string;
  name: string;
  style: 'anime' | 'soft' | 'chibi';
  image_name: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
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

export async function readAvatarJob(id: string): Promise<AvatarJob | null> {
  if (!validAvatarJobId(id)) return null;
  try {
    const job = JSON.parse(await readFile(join(avatarJobDir(id), 'job.json'), 'utf8')) as AvatarJob;
    try {
      const state = JSON.parse(await readFile(join(avatarJobDir(id), 'state.json'), 'utf8')) as {
        tpose_ref_image?: string;
      };
      if (state.tpose_ref_image) {
        job.preview_url = '/api/avatar-jobs/' + id + '/reference';
      }
    } catch { /* 参考图尚未生成 */ }
    return job;
  } catch {
    return null;
  }
}

export async function listAvatarJobs(): Promise<AvatarJob[]> {
  let names: string[];
  try { names = await readdir(AVATAR_JOBS_ROOT); }
  catch { return []; }
  const jobs = await Promise.all(names.filter(validAvatarJobId).map(readAvatarJob));
  return jobs.filter((job): job is AvatarJob => job !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function referencePath(id: string): Promise<string | null> {
  if (!validAvatarJobId(id)) return null;
  try {
    const dir = await realpath(avatarJobDir(id));
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

import { readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

export interface AvatarJob {
  id: string;
  name: string;
  style: 'anime' | 'soft' | 'chibi';
  image_name: string;
  /**
   * `awaiting_continue` 是本流程的关键状态：阶段②（背景清洗，5 积分）已完成，
   * 球在用户手上 —— 继续生成（建模 40 + 贴图 20 + 绑骨 25），还是换张图。
   * 把判断放在这里，是因为**只有用户能看出来背景清洗得对不对**，
   * 而后面那 85 积分一旦跑下去就收不回来了。
   */
  status: 'queued' | 'running' | 'awaiting_continue' | 'complete' | 'failed' | 'cancelled';
  stage: string;
  error?: string | null;
  avatar_url?: string;
  preview_url?: string;
  /** 正在跑这个任务的 node 进程 pid。放弃时靠它把整棵树杀掉。 */
  pid?: number | null;
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

/**
 * 改 job.json 的若干字段（原子写）。
 *
 * 语气上这是 API 层的东西，但它和 readAvatarJob 必须共用同一个目录解析
 * —— 否则"读的是 data/avatar-jobs、写的是别处"这种错会静默生效。
 */
export async function writeJobFields(id: string, fields: Partial<AvatarJob>): Promise<void> {
  if (!validAvatarJobId(id)) throw new Error('任务 ID 不合法');
  const path = join(avatarJobDir(id), 'job.json');
  const current = JSON.parse(await readFile(path, 'utf8')) as AvatarJob;
  const next = { ...current, ...fields, updated_at: new Date().toISOString() };
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
  await rename(temporary, path);
}

export async function listAvatarJobs(): Promise<AvatarJob[]> {
  let names: string[];
  try { names = await readdir(AVATAR_JOBS_ROOT); }
  catch { return []; }
  const jobs = await Promise.all(names.filter(validAvatarJobId).map(readAvatarJob));
  return jobs.filter((job): job is AvatarJob => job !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * 判断 child 是否真的在 parent 目录内。
 *
 * ★ 不能写成 `child.startsWith(parent + '/')` —— 那个写法在 **Windows 上恒为 false**：
 *   path 用反斜杠，所以 `'D:\\...\\abc\\0_tpose_ref\\x.png'.startsWith('D:\\...\\abc/')`
 *   永远是假的。后果不是“少一道检查”，而是**这道检查把正确的路径也拦了**：
 *   参考图永远 404、绑骨产物永远“路径不在任务目录”。
 *
 * 实测（win32）：
 *     目录内  旧写法 false ❌ / relative() true ✅
 *     目录外  旧写法 false    / relative() false ✅
 *
 * 也不能只把分隔符归一化就完事 —— `relative` 同时挡住了 ".." 逃逸与跨盘符。
 */
export function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const execFileAsync = promisify(execFile);

/**
 * 杀掉一个任务进程**连同它的子树**。
 *
 * 为什么不能只杀 pid：真正在烧 Tripo 积分的是它启动的 python 子进程，
 * 只把 node 收掉的话，python 会继续跑完整条管线（包括那 85 积分）。
 *
 * Windows 需要 `taskkill /T`；POSIX 下子进程是 detached 的（自成进程组），
 * 所以可以负号 pid 整组杀。
 */
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
    // 进程已经自己退了（任务刚跑完）也算“已经不在跑”，不是错误
    return false;
  }
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
    if (!isInsideDirectory(dir, image)) return null;
    if (!/\.(png|jpe?g|webp)$/i.test(image)) return null;
    return image;
  } catch { return null; }
}

/**
 * 起一个任务进程跑指定的阶段。spawn 成功后才返回 ——
 * 调用方要拿 child.pid 写进 job.json，不然「放弃」就杀不掉了。
 */
export async function spawnAvatarJob(
  // 不用 NodeJS.ProcessEnv：Next 给它加了必填的 NODE_ENV，
  // 而我们这里只关心“要额外注入哪几个变量”，用不着完整的环境类型。
  id: string, stage: 'ref' | 'full', env: Record<string, string | undefined>,
): Promise<number | undefined> {
  if (!validAvatarJobId(id)) throw new Error('任务 ID 不合法');
  if (!['ref', 'full'].includes(stage)) throw new Error('阶段不合法');
  const repo = resolve(process.cwd(), '..');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(repo, 'tools', 'avatar-job.mjs'), id, stage], {
    cwd: repo, env: { ...process.env, ...env },
    // detached：自成进程组，POSIX 下才能整组杀；配合 taskkill /T 覆盖 Windows。
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  await new Promise<void>((done, failed) => {
    child.once('spawn', done);
    child.once('error', failed);
  });
  child.unref();
  return child.pid;
}

/**
 * 把任务回到"只有原图"的状态：删掉 state.json 与上一版参考图。
 *
 * 换图时必须做这一步 —— 管线的续跑是以 state.json 为判据的，
 * 不清掉的话它会认为"背景清洗已经做过了"，直接拿旧图去建模。
 */
export async function resetAvatarJobState(id: string): Promise<void> {
  if (!validAvatarJobId(id)) throw new Error('任务 ID 不合法');
  const dir = avatarJobDir(id);
  await rm(join(dir, 'state.json'), { force: true });
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('0') || name.startsWith('1') || name.startsWith('2') || name.startsWith('3')) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

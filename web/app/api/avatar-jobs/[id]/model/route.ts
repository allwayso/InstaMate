import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { avatarJobDir, readAvatarJob, referencePath, validAvatarJobId } from '@/lib/avatar-jobs';
import { localRequestOnly } from '@/lib/local-request';
import { getTripoConfig } from '@/lib/tripo-settings';

export const runtime = 'nodejs';

export async function POST(request: Request, context: RouteContext<'/api/avatar-jobs/[id]/model'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  if (!validAvatarJobId(id)) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  const lockPath = join(avatarJobDir(id), '.model-start.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return NextResponse.json({ error: '3D 任务正在启动，请稍后查看状态' }, { status: 409 });
    if (code === 'ENOENT') return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    return NextResponse.json({ error: '无法锁定 3D 任务' }, { status: 500 });
  }
  try {
    const deletionLock = await lstat(join(avatarJobDir(id), '.delete.lock')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (deletionLock) return NextResponse.json({ error: '任务正在清理，请稍后再试' }, { status: 409 });
    const job = await readAvatarJob(id);
    if (!job) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    if (job.status !== 'image-ready' && !(job.status === 'failed' && job.preview_url)) {
      return NextResponse.json({ error: '请先完成动漫图片生成' }, { status: 409 });
    }
    if (!await referencePath(id)) {
      return NextResponse.json({ error: '动漫参考图文件不可用' }, { status: 409 });
    }
    let tripo;
    try { tripo = await getTripoConfig(); }
    catch { return NextResponse.json({ error: 'Tripo 3D 服务地址不正确' }, { status: 503 }); }
    const hostname = new URL(tripo.baseUrl).hostname;
    if (hostname === 'dashscope.aliyuncs.com' || hostname.endsWith('.aliyuncs.com')) {
      return NextResponse.json({ error: '当前 Tripo 地址填写的是阿里百炼；3D 建模需要独立的 Tripo API Key 和地址' }, { status: 503 });
    }
    if (!tripo.key) return NextResponse.json({ error: '请先填写 Tripo 3D 建模服务的 API Key' }, { status: 503 });
    const repo = resolve(process.cwd(), '..');
    const next = { ...job, status: 'queued', stage: '等待 Tripo 3D 建模', error: undefined,
      updated_at: new Date().toISOString() };
    const path = join(avatarJobDir(id), 'job.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2));
      await rename(temporary, path);
      const modelEnv = { ...process.env };
      delete modelEnv.DASHSCOPE_API_KEY;
      delete modelEnv.DASHSCOPE_BASE_URL;
      delete modelEnv.DASHSCOPE_WS_URL;
      modelEnv.TRIPO_API_KEY = tripo.key;
      modelEnv.TRIPO_BASE_URL = tripo.baseUrl;
      const child = spawn(process.execPath, [join(repo, 'tools', 'avatar-job.mjs'), id, 'model'], {
        cwd: repo, env: modelEnv,
        detached: true, stdio: 'ignore',
      });
      await new Promise<void>((done, failed) => {
        child.once('spawn', done);
        child.once('error', failed);
      });
      child.unref();
      return NextResponse.json(next, { status: 202 });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const rollback = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(rollback, JSON.stringify(job, null, 2));
        await rename(rollback, path);
      } catch {
        await rm(rollback, { force: true }).catch(() => undefined);
      }
      return NextResponse.json({ error: error instanceof Error ? error.message : '3D 任务启动失败' }, { status: 500 });
    }
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

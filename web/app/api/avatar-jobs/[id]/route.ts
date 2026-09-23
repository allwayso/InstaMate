import { NextResponse } from 'next/server';
import {
  deleteFinishedAvatarJob, killAvatarJobTree, readAvatarJob, validAvatarJobId, writeJobFields,
} from '@/lib/avatar-jobs';
import { localRequestOnly } from '@/lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext<'/api/avatar-jobs/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const job = await readAvatarJob(id);
  return job ? NextResponse.json(job, { headers: { 'cache-control': 'no-store' } })
    : NextResponse.json({ error: '任务不存在' }, { status: 404 });
}

export async function DELETE(request: Request, context: RouteContext<'/api/avatar-jobs/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  if (!validAvatarJobId(id)) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  try {
    const job = await readAvatarJob(id);
    if (!job) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    if (job.generation_mode === 'tripo' &&
        ['queued', 'running', 'awaiting_continue'].includes(job.status)) {
      const killed = typeof job.pid === 'number' ? await killAvatarJobTree(job.pid) : false;
      await writeJobFields(id, { status: 'cancelled', stage: '已放弃', pid: null });
      return NextResponse.json({ ...(await readAvatarJob(id)), killed },
        { headers: { 'cache-control': 'no-store' } });
    }
    const result = await deleteFinishedAvatarJob(id);
    if (result === 'deleted') return NextResponse.json({ deletedId: id }, { headers: { 'cache-control': 'no-store' } });
    if (result === 'not-found') return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    return NextResponse.json({ error: result === 'active' ? '任务正在生成，暂不能删除' : '任务正在启动或清理，请稍后再试' }, { status: 409 });
  } catch {
    return NextResponse.json({ error: '清理任务失败，请检查本地文件' }, { status: 500 });
  }
}

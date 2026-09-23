import { NextResponse } from 'next/server';
import { killAvatarJobTree, readAvatarJob, writeJobFields } from '@/lib/avatar-jobs';
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

/**
 * 放弃这个任务。
 *
 * 为什么需要它：阶段②之后用户可以选"继续生成"，但那是 85 积分。
 * 在花之前他得能说"算了" —— 而且说"算了"必须是**真的算了**：
 * 把整棵进程树杀掉。只标记状态不改进程的话，python 还在后台把管线跑完，
 * 积分照样扣，用户看到的是"我明明取消了，钱还是没了"。
 */
export async function DELETE(request: Request, context: RouteContext<'/api/avatar-jobs/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const job = await readAvatarJob(id);
  if (!job) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (job.status === 'complete') {
    return NextResponse.json(
      { error: '任务已完成，放弃请直接删除生成的模型文件' }, { status: 409 });
  }
  const killed = typeof job.pid === 'number' ? await killAvatarJobTree(job.pid) : false;
  await writeJobFields(id, { status: 'cancelled', stage: '已放弃', pid: null });
  return NextResponse.json({ ok: true, killed }, { headers: { 'cache-control': 'no-store' } });
}

import { NextResponse } from 'next/server';
import { readAvatarJob } from '@/lib/avatar-jobs';
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

import { NextResponse } from 'next/server';
import { readAvatarJob, spawnAvatarJob, writeJobFields } from '@/lib/avatar-jobs';
import { localRequestOnly } from '@/lib/local-request';
import { getTripoConfig } from '@/lib/tripo-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 用户看过背景清洗的平面图之后，选择继续。
 *
 * 这一步会是 85 积分（建模 40 + 贴图 20 + 绑骨 25），所以它必须由**用户显式触发**，
 * 而不是建任务时顺手跑完。同时它只接受 `awaiting_continue` 的任务 ——
 * 否则重复点击会把整条管线跑两遍，钱花两次。
 */
export async function POST(request: Request, context: RouteContext<'/api/avatar-jobs/[id]/continue'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const job = await readAvatarJob(id);
  if (!job) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (job.status !== 'awaiting_continue') {
    return NextResponse.json(
      { error: '这个任务当前不在等待确认状态，不能继续' }, { status: 409 });
  }

  let tripo;
  try { tripo = await getTripoConfig(); }
  catch { return NextResponse.json({ error: 'Tripo API 地址不正确，请检查服务设置' }, { status: 503 }); }
  if (!tripo.key) return NextResponse.json({ error: '缺少 Tripo API Key' }, { status: 503 });

  try {
    const pid = await spawnAvatarJob(id, 'full', {
      TRIPO_API_KEY: tripo.key, TRIPO_BASE_URL: tripo.baseUrl,
    });
    await writeJobFields(id, {
      status: 'running', stage: '建模、贴图与绑骨', pid: pid ?? null, error: null,
    });
    return NextResponse.json(await readAvatarJob(id), { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '无法启动生成' }, { status: 500 });
  }
}

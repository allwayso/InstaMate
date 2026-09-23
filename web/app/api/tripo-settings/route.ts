import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { getTripoConfig, publicTripoStatus, saveTripoConfig } from '@/lib/tripo-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    return NextResponse.json(publicTripoStatus(await getTripoConfig()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: '读取 Tripo 配置失败，请检查 tripo/.env' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  if (Number(request.headers.get('content-length')) > 4_096) {
    return NextResponse.json({ error: '配置内容过大' }, { status: 413 });
  }
  try {
    const body = await request.json() as { key?: unknown; baseUrl?: unknown };
    if (typeof body.key !== 'string' || typeof body.baseUrl !== 'string') {
      return NextResponse.json({ error: '配置格式不正确' }, { status: 400 });
    }
    const status = await saveTripoConfig(body.key, body.baseUrl);
    return NextResponse.json(status, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '配置格式不正确' }, { status: 400 });
    if (error instanceof Error && /^(请输入|API 地址|API Key|请填写)/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: '保存 Tripo 配置失败，请检查本机文件权限' }, { status: 500 });
  }
}

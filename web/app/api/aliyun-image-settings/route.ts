import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import {
  getAliyunImageConfig,
  publicAliyunImageStatus,
  saveAliyunImageConfig,
  type ImageProvider,
} from '@/lib/aliyun-image-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    return NextResponse.json(publicAliyunImageStatus(await getAliyunImageConfig()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: '读取百炼图片配置失败' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  if (Number(request.headers.get('content-length')) > 4_096) {
    return NextResponse.json({ error: '配置内容过大' }, { status: 413 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.key !== 'string' || typeof body.baseUrl !== 'string' ||
        (body.provider !== 'qwen' && body.provider !== 'wanx') || typeof body.model !== 'string') {
      return NextResponse.json({ error: '配置格式不正确' }, { status: 400 });
    }
    const status = await saveAliyunImageConfig({
      key: body.key, baseUrl: body.baseUrl, provider: body.provider as ImageProvider, model: body.model,
    });
    return NextResponse.json(status, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: '配置格式不正确' }, { status: 400 });
    }
    if (error instanceof Error && /^(请填写|百炼地址|图片模型|API Key)/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: '保存百炼配置失败，请检查本机文件权限' }, { status: 500 });
  }
}

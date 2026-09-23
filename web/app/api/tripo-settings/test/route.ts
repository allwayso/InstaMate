import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { getTripoConfig } from '@/lib/tripo-settings';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    const config = await getTripoConfig();
    if (!config.key) return NextResponse.json({ error: '请先保存 Tripo API Key' }, { status: 400 });
    const response = await fetch(`${config.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${config.key}` },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      return NextResponse.json({ error: `Tripo 返回 HTTP ${response.status}，请检查 API Key 和地址` }, { status: 502 });
    }
    const result = await response.json() as { code?: number };
    if (result.code !== 0) {
      return NextResponse.json({ error: 'Tripo 未通过密钥验证，请检查账号和 API 地址' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, message: '连接成功，Tripo 已接受当前密钥' });
  } catch {
    return NextResponse.json({ error: '无法连接 Tripo，请检查网络和 API 地址' }, { status: 502 });
  }
}

import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { stateFile } from '@/lib/states-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext<'/api/states/[id]/file'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const result = await stateFile(id);
  if (!result) return NextResponse.json({ error: '状态素材不存在' }, { status: 404 });
  return new Response(new Uint8Array(result.data), {
    headers: {
      'content-type': result.type,
      'content-disposition': `attachment; filename="${result.name}"`,
      'cache-control': 'private, no-store',
    },
  });
}

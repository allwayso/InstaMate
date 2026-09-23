import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { NextResponse } from 'next/server';
import { referencePath } from '@/lib/avatar-jobs';
import { localRequestOnly } from '@/lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext<'/api/avatar-jobs/[id]/reference'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const path = await referencePath(id);
  if (!path) return NextResponse.json({ error: '参考图尚未生成' }, { status: 404 });
  const extension = extname(path).toLowerCase();
  const type = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  return new Response(new Uint8Array(await readFile(path)), {
    headers: { 'content-type': type, 'cache-control': 'private, no-store' },
  });
}

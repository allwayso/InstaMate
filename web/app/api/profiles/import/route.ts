import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { forwardMemory } from '@/lib/memory-proxy';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 10_000_000) {
    return NextResponse.json({ error: 'ZIP 文件须小于 10 MB' }, { status: 400 });
  }
  return forwardMemory('/api/profiles/import', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: bytes,
  });
}

import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { deleteState, listStates } from '@/lib/states-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext<'/api/states/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const state = (await listStates()).find((entry) => entry.id === id);
  return state ? NextResponse.json({ state }) : NextResponse.json({ error: '状态不存在' }, { status: 404 });
}

export async function DELETE(request: Request, context: RouteContext<'/api/states/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const deleted = await deleteState(id);
  return deleted ? NextResponse.json({ ok: true }) : NextResponse.json({ error: '状态不存在' }, { status: 404 });
}

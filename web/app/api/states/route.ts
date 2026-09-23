import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { createState, listStates } from '@/lib/states-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    return NextResponse.json({ states: await listStates() }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '状态库读取失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const triggerWords = String(form.get('trigger_words') ?? '')
      .split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
    const durationValue = Number(form.get('duration'));
    const duration = Number.isFinite(durationValue) && durationValue > 0
      ? Math.min(durationValue, 600) : null;
    const file = form.get('file');
    const entry = await createState({
      name,
      trigger_words: triggerWords,
      emotion: String(form.get('emotion') ?? 'neutral').slice(0, 30),
      loop: form.get('loop') === 'true',
      duration,
      clip_id: String(form.get('clip_id') ?? '').trim() || null,
    }, file instanceof File && file.size ? file : null);
    return NextResponse.json({ state: entry }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '状态保存失败' }, { status: 400 });
  }
}

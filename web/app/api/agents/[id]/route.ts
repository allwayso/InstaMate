import { NextResponse } from 'next/server';
import { localRequestOnly } from '@/lib/local-request';
import { forwardMemory } from '@/lib/memory-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `default` 是合法取值 —— 它不是 32 位 hex，也不会和真实档案撞名。 */
const AGENT_ID_RE = /^(default|[0-9a-f]{32})$/;

export async function GET(request: Request, context: RouteContext<'/api/agents/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  if (!AGENT_ID_RE.test(id)) {
    return NextResponse.json({ error: '智能体 ID 不合法' }, { status: 400 });
  }
  return forwardMemory('/api/agents/' + id);
}

/**
 * 重新渲染 system_prompt.md / memory.md。
 *
 * 只覆盖这两个文件，**不动** `profiles/<id>.json` ——
 * 那是分析结果本身，重生成时要能对比"改前改后差了什么"。
 */
export async function POST(request: Request, context: RouteContext<'/api/agents/[id]'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  if (!AGENT_ID_RE.test(id)) {
    return NextResponse.json({ error: '智能体 ID 不合法' }, { status: 400 });
  }
  return forwardMemory(`/api/agents/${id}/regenerate`, { method: 'POST' });
}

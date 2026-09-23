import { localRequestOnly } from '@/lib/local-request';
import { forwardMemory } from '@/lib/memory-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 列出所有智能体（默认档 + 每个已生成的档案）。
 *
 * 为什么要这个接口：改动之后，对话用的不再是原始档案 JSON，
 * 而是分析阶段生成好的 `system_prompt.md` / `memory.md`。
 * 没有可查看的地方，用户就只能猜「智能体到底拿到了什么」——
 * 那比改动前更糟（改动前至少能打开 profile JSON 看）。
 */
export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  return gate ?? forwardMemory('/api/agents');
}

import { localRequestOnly } from '@/lib/local-request';
import { forwardMemory } from '@/lib/memory-proxy';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const body = await request.text();
  return forwardMemory('/api/profiles/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

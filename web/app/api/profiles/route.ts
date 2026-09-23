import { localRequestOnly } from '@/lib/local-request';
import { forwardMemory } from '@/lib/memory-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  return gate ?? forwardMemory('/api/profiles');
}

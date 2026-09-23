import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

export interface StateEntry {
  id: string;
  name: string;
  trigger_words: string[];
  emotion: string;
  loop: boolean;
  duration: number | null;
  clip_id: string | null;
  file: string | null;
  file_type: 'glb' | 'video' | null;
  created_at: string;
}

export interface StateInput {
  name: string;
  trigger_words: string[];
  emotion: string;
  loop: boolean;
  duration: number | null;
  clip_id: string | null;
}

const root = process.env.STATES_DIR
  ? resolve(/* turbopackIgnore: true */ process.env.STATES_DIR)
  : resolve(process.cwd(), '..', 'data', 'states');
const indexPath = join(root, 'states.json');
const fileDir = join(root, 'files');
const clipIndexPath = resolve(process.cwd(), 'public', 'clips', 'index.json');
const allowedExt = new Set(['.glb', '.mp4', '.webm', '.mov']);
export const MAX_STATE_FILE_BYTES = 20 * 1024 * 1024;

let pending: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(operation, operation);
  pending = next.catch(() => undefined);
  return next;
}

async function clipCatalog(): Promise<{ id: string; name: string; duration: number }[]> {
  const parsed = JSON.parse(await readFile(clipIndexPath, 'utf8')) as {
    clips?: { id: string; name: string; duration: number }[];
  };
  return Array.isArray(parsed.clips) ? parsed.clips : [];
}

async function defaults(): Promise<StateEntry[]> {
  const clips = await clipCatalog();
  const terms: Record<string, string[]> = {
    'wave-right-hand': ['你好', 'hi', '挥手', '打招呼'],
    'raise-right-arm': ['举右手', '抬右手'],
    'raise-left-arm': ['举左手', '抬左手'],
    'bend-right-elbow': ['弯右臂'],
    'bend-left-elbow': ['弯左臂'],
    'turn-head': ['转头', '摇头'],
  };
  return clips.map((clip) => ({
    id: `clip-${clip.id}`,
    name: clip.name,
    trigger_words: terms[clip.id] ?? [],
    emotion: 'neutral',
    loop: false,
    duration: Number.isFinite(clip.duration) ? clip.duration : null,
    clip_id: clip.id,
    file: null,
    file_type: null,
    created_at: 'builtin',
  }));
}

export async function listStates(): Promise<StateEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('状态库索引格式错误');
    return parsed as StateEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw error;
  }
}

async function writeIndex(states: StateEntry[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(states, null, 2), 'utf8');
    await rename(temporary, indexPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function createState(input: StateInput, file: File | null): Promise<StateEntry> {
  return serialize(async () => {
    if (!input.name.trim() || input.name.length > 80) throw new Error('状态名称须为 1–80 个字符');
    const selectedClip = input.clip_id ? (await clipCatalog()).find((clip) => clip.id === input.clip_id) : null;
    if (input.clip_id && !selectedClip) {
      throw new Error('所选动作不存在');
    }
    const extension = file ? extname(file.name).toLowerCase() : '';
    if (file && (!allowedExt.has(extension) || file.size > MAX_STATE_FILE_BYTES || file.size === 0)) {
      throw new Error('素材仅支持不超过 20 MB 的 GLB、MP4、WebM 或 MOV');
    }
    const id = `st_${randomUUID()}`;
    const stored = file ? `${id}${extension}` : null;
    const entry: StateEntry = {
      id,
      name: input.name.trim(),
      trigger_words: input.trigger_words.map((word) => word.trim()).filter(Boolean).slice(0, 20),
      emotion: input.emotion,
      loop: input.loop,
      duration: input.duration ?? selectedClip?.duration ?? null,
      clip_id: input.clip_id,
      file: stored,
      file_type: extension === '.glb' ? 'glb' : extension ? 'video' : null,
      created_at: new Date().toISOString(),
    };
    if (file && stored) {
      await mkdir(fileDir, { recursive: true });
      await writeFile(join(fileDir, stored), Buffer.from(await file.arrayBuffer()));
    }
    try {
      await writeIndex([...(await listStates()), entry]);
    } catch (error) {
      if (stored) await rm(join(fileDir, stored), { force: true }).catch(() => undefined);
      throw error;
    }
    return entry;
  });
}

export async function deleteState(id: string): Promise<boolean> {
  return serialize(async () => {
    const states = await listStates();
    const entry = states.find((state) => state.id === id);
    if (!entry) return false;
    await writeIndex(states.filter((state) => state.id !== id));
    if (entry.file) await rm(join(fileDir, entry.file), { force: true }).catch(() => undefined);
    return true;
  });
}

export async function stateFile(id: string): Promise<{ name: string; data: Buffer; type: string } | null> {
  const entry = (await listStates()).find((state) => state.id === id);
  if (!entry?.file || !/^st_[a-f0-9-]+\.(glb|mp4|webm|mov)$/.test(entry.file)) return null;
  try {
    const data = await readFile(join(fileDir, entry.file));
    const type = entry.file_type === 'glb' ? 'model/gltf-binary' :
      entry.file.endsWith('.mp4') ? 'video/mp4' :
      entry.file.endsWith('.webm') ? 'video/webm' : 'video/quicktime';
    return { name: entry.file, data, type };
  } catch {
    return null;
  }
}

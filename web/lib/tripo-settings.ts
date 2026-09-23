import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_TRIPO_BASE_URL = 'https://api.tripo3d.com/v2/openapi';
const SETTINGS_PATH = resolve(process.cwd(), '..', 'tripo', '.env');

type TripoConfig = { key: string; baseUrl: string; keySource: 'local-file' | 'environment' | 'missing' };

function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

async function readSettingsFile(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function validateTripoBaseUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('请输入完整的 Tripo API 地址，例如 https://api.tripo3d.com/v2/openapi'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址须为 HTTPS；仅本机地址可使用 HTTP，且不能带账号、参数或片段');
  }
  return url.toString().replace(/\/+$/, '');
}

export async function getTripoConfig(path = SETTINGS_PATH): Promise<TripoConfig> {
  const file = parseEnv(await readSettingsFile(path));
  const fileKey = file.TRIPO_API_KEY || file.api_key;
  const environmentKey = process.env.TRIPO_API_KEY || process.env.api_key;
  const key = fileKey || environmentKey || '';
  const rawBaseUrl = file.TRIPO_BASE_URL || process.env.TRIPO_BASE_URL || DEFAULT_TRIPO_BASE_URL;
  return {
    key,
    baseUrl: validateTripoBaseUrl(rawBaseUrl),
    keySource: fileKey ? 'local-file' : environmentKey ? 'environment' : 'missing',
  };
}

export function publicTripoStatus(config: TripoConfig) {
  return {
    configured: Boolean(config.key),
    keySource: config.keySource,
    baseUrl: config.baseUrl,
  };
}

export async function saveTripoConfig(keyInput: string, baseUrlInput: string, path = SETTINGS_PATH) {
  const baseUrl = validateTripoBaseUrl(baseUrlInput);
  const key = keyInput.trim();
  if (key && !/^[A-Za-z0-9._~+/=-]{1,512}$/.test(key)) {
    throw new Error('API Key 格式不正确：只能包含常见令牌字符，长度不超过 512');
  }
  const previous = await readSettingsFile(path);
  const previousValues = parseEnv(previous);
  const existingKey = previousValues.TRIPO_API_KEY || previousValues.api_key ||
    process.env.TRIPO_API_KEY || process.env.api_key;
  if (!key && !existingKey) throw new Error('请填写 Tripo API Key');
  const lines = previous.split(/\r?\n/).filter((line) => {
    if (/^\s*(?:export\s+)?TRIPO_BASE_URL\s*=/.test(line)) return false;
    if (key && /^\s*(?:export\s+)?(?:TRIPO_API_KEY|api_key)\s*=/.test(line)) return false;
    return true;
  });
  while (lines.at(-1) === '') lines.pop();
  if (key) lines.push(`TRIPO_API_KEY=${JSON.stringify(key)}`);
  lines.push(`TRIPO_BASE_URL=${JSON.stringify(baseUrl)}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return publicTripoStatus(await getTripoConfig(path));
}

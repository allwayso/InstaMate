import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getTripoConfig } from './tripo-settings.ts';

export type ImageProvider = 'qwen' | 'wanx';
export type ImageModel = 'qwen-image-3.0' | 'qwen-image-3.0-pro' | 'wan2.7-image-pro';
export const DEFAULT_ALIYUN_IMAGE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const ALIYUN_IMAGE_SETTINGS_PATH = resolve(process.cwd(), '..', 'data', 'settings', 'aliyun-image.json');

const MODELS: Record<ImageProvider, readonly ImageModel[]> = {
  qwen: ['qwen-image-3.0', 'qwen-image-3.0-pro'],
  wanx: ['wan2.7-image-pro'],
};
const DEFAULT_MODEL: Record<ImageProvider, ImageModel> = {
  qwen: 'qwen-image-3.0',
  wanx: 'wan2.7-image-pro',
};

export interface AliyunImageConfig {
  key: string;
  baseUrl: string;
  provider: ImageProvider;
  model: ImageModel;
  keySource: 'local-file' | 'environment' | 'legacy-tripo' | 'missing';
}

export function validateAliyunImageBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('请填写阿里百炼兼容接口地址'); }
  const allowedHost = url.hostname === 'dashscope.aliyuncs.com' ||
    url.hostname === 'dashscope-intl.aliyuncs.com' ||
    url.hostname.endsWith('.maas.aliyuncs.com');
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/+$/, '') !== '/compatible-mode/v1') {
    throw new Error('百炼地址须是阿里云的 HTTPS /compatible-mode/v1 接口，不能填写 Tripo 地址');
  }
  return url.toString().replace(/\/+$/, '');
}

export function validateImageModel(provider: ImageProvider, model: string): ImageModel {
  if (!MODELS[provider].includes(model as ImageModel)) throw new Error('图片模型与服务不匹配');
  return model as ImageModel;
}

async function readSaved(path: string): Promise<Partial<AliyunImageConfig>> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Partial<AliyunImageConfig>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** 旧页面把百炼密钥误存进 Tripo 配置时，只在地址确属阿里百炼时读取它。 */
async function legacyAliyunSettings(): Promise<{ key: string; baseUrl: string } | null> {
  try {
    const legacy = await getTripoConfig();
    const baseUrl = validateAliyunImageBaseUrl(legacy.baseUrl);
    return legacy.key ? { key: legacy.key, baseUrl } : null;
  } catch { return null; }
}

export async function getAliyunImageConfig(path = ALIYUN_IMAGE_SETTINGS_PATH): Promise<AliyunImageConfig> {
  const saved = await readSaved(path);
  const legacy = await legacyAliyunSettings();
  const fileKey = typeof saved.key === 'string' ? saved.key : '';
  const envKey = process.env.DASHSCOPE_API_KEY ?? '';
  // Keep a key and its workspace URL together. A generic process key may belong
  // to a different region/workspace than the URL saved in the old page.
  const preferLegacy = Boolean(legacy && !saved.baseUrl && !process.env.DASHSCOPE_BASE_URL);
  const key = fileKey || (preferLegacy ? legacy?.key : '') || envKey || legacy?.key || '';
  const provider = saved.provider === 'wanx' ? 'wanx' : 'qwen';
  const model = validateImageModel(provider, saved.model || DEFAULT_MODEL[provider]);
  const rawBaseUrl = saved.baseUrl || process.env.DASHSCOPE_BASE_URL || legacy?.baseUrl || DEFAULT_ALIYUN_IMAGE_BASE_URL;
  return {
    key,
    baseUrl: validateAliyunImageBaseUrl(rawBaseUrl),
    provider,
    model,
    keySource: fileKey ? 'local-file' : preferLegacy ? 'legacy-tripo' : envKey ? 'environment' : legacy?.key ? 'legacy-tripo' : 'missing',
  };
}

export function publicAliyunImageStatus(config: AliyunImageConfig) {
  return {
    configured: Boolean(config.key),
    keySource: config.keySource,
    baseUrl: config.baseUrl,
    provider: config.provider,
    model: config.model,
  };
}

export async function saveAliyunImageConfig(
  input: { key: string; baseUrl: string; provider: ImageProvider; model: string },
  path = ALIYUN_IMAGE_SETTINGS_PATH,
) {
  const previous = await getAliyunImageConfig(path);
  const key = input.key.trim() || previous.key;
  if (!key) throw new Error('请填写阿里百炼 API Key');
  if (!/^[A-Za-z0-9._~+/=-]{1,512}$/.test(key)) throw new Error('API Key 格式不正确');
  const config: AliyunImageConfig = {
    key,
    baseUrl: validateAliyunImageBaseUrl(input.baseUrl),
    provider: input.provider,
    model: validateImageModel(input.provider, input.model),
    keySource: 'local-file',
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return publicAliyunImageStatus(config);
}

/** Alibaba Cloud Model Studio photo editing for the avatar reference stage. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MODEL_TIMEOUT_MS = 600_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

function nativeBaseUrl(compatibleBaseUrl) {
  const url = new URL(compatibleBaseUrl);
  url.pathname = '/api/v1';
  return url.toString().replace(/\/+$/, '');
}

function inputMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  throw new Error('输入照片必须是 JPG 或 PNG');
}

function outputExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('百炼没有返回可供 3D 建模使用的图片');
}

function imageResult(payload, provider) {
  if (provider === 'qwen') {
    const first = payload?.data?.[0];
    if (typeof first?.url === 'string') return first.url;
    if (typeof first?.b64_json === 'string') return `data:image/png;base64,${first.b64_json}`;
  } else {
    const content = payload?.output?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
      const item = content.find((part) => part?.type === 'image' && typeof part.image === 'string');
      if (item) return item.image;
    }
  }
  throw new Error('百炼没有返回生成图片，请检查模型权限与提示词');
}

async function fetchImage(result, fetchImpl) {
  if (result.startsWith('data:image/')) {
    const match = result.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('百炼返回的 Base64 图片格式不正确');
    return Buffer.from(match[2], 'base64');
  }
  const url = new URL(result);
  if (url.protocol !== 'https:' ||
      !(url.hostname === 'aliyuncs.com' || url.hostname.endsWith('.aliyuncs.com'))) {
    throw new Error('百炼返回了非阿里云图片地址，已拒绝下载');
  }
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`百炼图片下载失败（HTTP ${response.status}）`);
  const declared = Number(response.headers?.get('content-length'));
  if (declared > MAX_OUTPUT_BYTES) throw new Error('百炼图片超过 25 MB');
  return Buffer.from(await response.arrayBuffer());
}

/** Reuses the prior InstaMate /api/anime request formats, then persists a rigging reference image. */
export async function generateAnimeReference({
  inputPath, runDir, provider, model, baseUrl, apiKey, prompt, fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('缺少阿里百炼 API Key');
  if (provider !== 'qwen' && provider !== 'wanx') throw new Error('未知图片服务');
  const photo = await readFile(inputPath);
  if (photo.length > (provider === 'qwen' ? 10 : 20) * 1024 * 1024) {
    throw new Error(provider === 'qwen' ? '千问参考照片不能超过 10 MB' : '万相参考照片不能超过 20 MB');
  }
  const photoDataUrl = `data:${inputMime(photo)};base64,${photo.toString('base64')}`;
  const url = provider === 'qwen'
    ? `${baseUrl}/images/generations`
    : `${nativeBaseUrl(baseUrl)}/services/aigc/multimodal-generation/generation`;
  const body = provider === 'qwen'
    ? { model, prompt, image: photoDataUrl, prompt_extend: true, size: '1024x1024', n: 1 }
    : {
        model,
        input: { messages: [{ role: 'user', content: [{ image: photoDataUrl }, { text: prompt }] }] },
        parameters: { size: '2K', n: 1, watermark: false },
      };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const detail = payload?.error?.message || payload?.message || payload?.code || '';
    throw new Error(`百炼图片生成失败（HTTP ${response.status}${detail ? `：${String(detail).slice(0, 180)}` : ''}）`);
  }
  const result = imageResult(await response.json(), provider);
  const bytes = await fetchImage(result, fetchImpl);
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) throw new Error('百炼图片大小不合法');
  const extension = outputExtension(bytes);
  const folder = join(runDir, '00_tpose_ref');
  await mkdir(folder, { recursive: true });
  const imagePath = join(folder, `tpose_ref.${extension}`);
  await writeFile(imagePath, bytes);
  const statePath = join(runDir, 'state.json');
  let state = {};
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state = {
    ...state,
    status: 'running',
    source_image: inputPath,
    image_provider: provider,
    image_model: model,
    tpose_ref_image: imagePath,
    tpose_ref_files: [imagePath],
  };
  const temporary = `${statePath}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, statePath);
  return { imagePath, state };
}

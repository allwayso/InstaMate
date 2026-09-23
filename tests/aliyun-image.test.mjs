import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateAnimeReference } from '../tools/aliyun-image.mjs';
import { saveAliyunImageConfig, validateAliyunImageBaseUrl } from '../web/lib/aliyun-image-settings.ts';
import { DEFAULT_TRIPO_BASE_URL, publicTripoStatus, saveTripoConfig } from '../web/lib/tripo-settings.ts';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const RESULT_URL = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/result.png';
const BASE = 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

async function withRun(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'instamate-aliyun-image-'));
  const inputPath = join(dir, 'input.png');
  await writeFile(inputPath, PNG);
  try { await callback({ dir, inputPath }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('千问图片编辑使用旧项目的 images/generations 协议并保存参考图', async () => {
  await withRun(async ({ dir, inputPath }) => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? Response.json({ data: [{ url: RESULT_URL }] })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } });
    };
    const result = await generateAnimeReference({
      inputPath, runDir: dir, provider: 'qwen', model: 'qwen-image-3.0',
      baseUrl: BASE, apiKey: 'test-key', prompt: '动漫 T-pose', fetchImpl: mockFetch,
    });
    assert.equal(calls[0].url, BASE + '/images/generations');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'qwen-image-3.0');
    assert.match(body.image, /^data:image\/png;base64,/);
    assert.equal(body.prompt, '动漫 T-pose');
    assert.equal(calls[1].url, RESULT_URL);
    assert.deepEqual(await readFile(result.imagePath), PNG);
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.tpose_ref_image, result.imagePath);
    assert.equal(state.image_provider, 'qwen');
    assert.equal(JSON.stringify(state).includes('test-key'), false);
  });
});

test('万相使用同业务空间的原生同步端点', async () => {
  await withRun(async ({ dir, inputPath }) => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? Response.json({ output: { choices: [{ message: { content: [{ type: 'image', image: RESULT_URL }] } }] } })
        : new Response(PNG);
    };
    await generateAnimeReference({
      inputPath, runDir: dir, provider: 'wanx', model: 'wan2.7-image-pro',
      baseUrl: BASE, apiKey: 'test-key', prompt: '动漫 T-pose', fetchImpl: mockFetch,
    });
    assert.equal(calls[0].url,
      'https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'wan2.7-image-pro');
    assert.equal(body.input.messages[0].content[0].image.startsWith('data:image/png;base64,'), true);
    assert.equal(body.parameters.size, '2K');
  });
});

test('百炼密钥不能被发送到非阿里云图片地址或 Tripo 配置', async () => {
  await withRun(async ({ dir, inputPath }) => {
    const mockFetch = async () => Response.json({ data: [{ url: 'http://127.0.0.1/secret' }] });
    await assert.rejects(generateAnimeReference({
      inputPath, runDir: dir, provider: 'qwen', model: 'qwen-image-3.0',
      baseUrl: BASE, apiKey: 'test-key', prompt: '动漫', fetchImpl: mockFetch,
    }), /非阿里云图片地址/);
    assert.throws(() => validateAliyunImageBaseUrl('https://api.tripo3d.com/v2/openapi'), /百炼地址/);
    const configPath = join(dir, 'aliyun-image.json');
    const publicStatus = await saveAliyunImageConfig({
      key: 'test-key', baseUrl: BASE, provider: 'qwen', model: 'qwen-image-3.0',
    }, configPath);
    assert.equal(publicStatus.configured, true);
    assert.equal(JSON.stringify(publicStatus).includes('test-key'), false);
    assert.equal(publicTripoStatus({ key: 'test-key', baseUrl: BASE, keySource: 'local-file' }).configured, false);
    await assert.rejects(saveTripoConfig('test-key', BASE, join(dir, 'tripo.env')), /API 地址是阿里百炼/);
    const oldTripoPath = join(dir, 'old-tripo.env');
    await writeFile(oldTripoPath, `TRIPO_API_KEY=test-key\nTRIPO_BASE_URL=${BASE}\n`);
    await assert.rejects(saveTripoConfig('', DEFAULT_TRIPO_BASE_URL, oldTripoPath), /Tripo 专用 API Key/);
  });
});

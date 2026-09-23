import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_TRIPO_BASE_URL, getTripoConfig, publicTripoStatus,
  saveTripoConfig, validateTripoBaseUrl,
} from '../web/lib/tripo-settings.ts';

test('Tripo 设置保存到本机文件，保留其它字段且不向页面回显密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instamate-tripo-'));
  const path = join(dir, '.env');
  try {
    writeFileSync(path, '# existing\nTRIPO_MODEL_VERSION=v3.1\napi_key=old_key\n');
    const status = await saveTripoConfig('tsk_new_key', 'https://api.tripo3d.com/v2/openapi/', path);
    assert.deepEqual(status, {
      configured: true, keySource: 'local-file', baseUrl: DEFAULT_TRIPO_BASE_URL,
    });
    assert.equal(JSON.stringify(status).includes('tsk_new_key'), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const content = readFileSync(path, 'utf8');
    assert.match(content, /TRIPO_MODEL_VERSION=v3\.1/);
    assert.doesNotMatch(content, /old_key/);
    assert.match(content, /TRIPO_API_KEY="tsk_new_key"/);
    assert.equal((await getTripoConfig(path)).key, 'tsk_new_key');

    await saveTripoConfig('', 'https://example.org/custom', path);
    assert.equal((await getTripoConfig(path)).key, 'tsk_new_key');
    assert.equal((await getTripoConfig(path)).baseUrl, 'https://example.org/custom');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Tripo 地址与密钥校验在写入前生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instamate-tripo-'));
  const path = join(dir, '.env');
  try {
    assert.throws(() => validateTripoBaseUrl('http://example.com/api'), /HTTPS/);
    assert.throws(() => validateTripoBaseUrl('https://user:pass@example.com/api'), /HTTPS/);
    assert.throws(() => validateTripoBaseUrl('https://example.com/api?key=secret'), /HTTPS/);
    assert.equal(validateTripoBaseUrl('http://localhost:9999/api/'), 'http://localhost:9999/api');
    await assert.rejects(saveTripoConfig('key with space', DEFAULT_TRIPO_BASE_URL, path), /API Key/);
    await assert.rejects(saveTripoConfig('', DEFAULT_TRIPO_BASE_URL, path), /请填写/);
    assert.throws(() => readFileSync(path), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('缺少本机文件时可读取环境变量，但公开状态不包含密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instamate-tripo-'));
  const path = join(dir, '.env');
  const previous = process.env.TRIPO_API_KEY;
  try {
    process.env.TRIPO_API_KEY = 'tsk_environment';
    const config = await getTripoConfig(path);
    assert.equal(config.keySource, 'environment');
    assert.equal(config.key, 'tsk_environment');
    assert.equal(JSON.stringify(publicTripoStatus(config)).includes('tsk_environment'), false);
  } finally {
    if (previous === undefined) delete process.env.TRIPO_API_KEY;
    else process.env.TRIPO_API_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

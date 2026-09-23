import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveDiagnostic, validateDiagnosticTrace } from '../web/lib/mocap/diagnostic-store.ts';

function sampleTrace() {
  return {
    schemaVersion: 1,
    kind: 'mocap-diagnostic',
    startedAt: '2026-09-23T10:00:00.000Z',
    durationMs: 1500,
    videoMimeType: 'video/webm;codecs=vp8',
    metadata: { avatarUrl: '/avatars/sample.vrm' },
    frames: [{ tMs: 100, raw: { poseWorldLandmarks: null }, solver: { pose: null } }],
  };
}

test('诊断视频与逐帧数据写入同一个独立目录，时间码原样保存', () => {
  const root = mkdtempSync(join(tmpdir(), 'instamate-diagnostic-'));
  try {
    const trace = sampleTrace();
    const saved = saveDiagnostic(new Uint8Array([1, 2, 3]), trace, 'video/webm;codecs=vp8', root);
    assert.equal(readdirSync(root).length, 1);
    assert.ok(existsSync(join(saved.path, 'comparison.webm')));
    assert.ok(existsSync(join(saved.path, 'README.txt')));
    assert.deepEqual(JSON.parse(readFileSync(join(saved.path, 'trace.json'), 'utf8')), trace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拒绝不匹配格式，并且不留下半成品目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'instamate-diagnostic-'));
  try {
    assert.throws(() => saveDiagnostic(new Uint8Array([1]), sampleTrace(), 'video/mp4', root));
    assert.deepEqual(readdirSync(root), []);
    assert.equal(validateDiagnosticTrace({ ...sampleTrace(), frames: [{ tMs: -1 }] }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

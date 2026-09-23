import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteAllFinishedAvatarJobs,
  deleteFinishedAvatarJob,
  readAvatarJob,
} from '../web/lib/avatar-jobs.ts';

async function withStorage(run) {
  const temp = mkdtempSync(join(tmpdir(), 'avatar-job-cleanup-'));
  const roots = { jobsRoot: join(temp, 'jobs'), avatarsRoot: join(temp, 'avatars') };
  mkdirSync(roots.jobsRoot);
  mkdirSync(roots.avatarsRoot);
  try { await run({ temp, roots }); }
  finally { rmSync(temp, { recursive: true, force: true }); }
}

function makeJob(roots, id, status) {
  const dir = join(roots.jobsRoot, id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'job.json'), JSON.stringify({
    id, name: '角色', style: 'anime', image_name: 'input.png', status,
    stage: '测试', created_at: '2026-09-23T00:00:00.000Z',
    updated_at: '2026-09-23T00:00:00.000Z',
  }));
  writeFileSync(join(dir, 'input.png'), 'photo');
  return dir;
}

test('删除已完成记录时只移除对应任务目录和 VRM，不追随目录里的符号链接', async () => {
  await withStorage(async ({ temp, roots }) => {
    const id = 'a'.repeat(32);
    const dir = makeJob(roots, id, 'complete');
    const outside = join(temp, 'keep.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(dir, 'external-link'));
    writeFileSync(join(roots.avatarsRoot, `${id}.vrm`), 'vrm');
    writeFileSync(join(roots.avatarsRoot, 'sample.vrm'), 'built-in');

    assert.equal(await deleteFinishedAvatarJob(id, roots), 'deleted');
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(join(roots.avatarsRoot, `${id}.vrm`)), false);
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
    assert.equal(readFileSync(join(roots.avatarsRoot, 'sample.vrm'), 'utf8'), 'built-in');
  });
});

test('运行中任务、建模启动锁和非法 ID 都不能删除', async () => {
  await withStorage(async ({ roots }) => {
    const queued = 'b'.repeat(32);
    const running = 'c'.repeat(32);
    const locked = 'd'.repeat(32);
    makeJob(roots, queued, 'queued');
    makeJob(roots, running, 'running');
    const lockedDir = makeJob(roots, locked, 'image-ready');
    writeFileSync(join(lockedDir, '.model-start.lock'), '');

    assert.equal(await deleteFinishedAvatarJob(queued, roots), 'active');
    assert.equal(await deleteFinishedAvatarJob(running, roots), 'active');
    assert.equal(await deleteFinishedAvatarJob(locked, roots), 'busy');
    assert.equal(await deleteFinishedAvatarJob('../' + queued, roots), 'not-found');
    for (const id of [queued, running, locked]) {
      assert.equal(existsSync(join(roots.jobsRoot, id, 'job.json')), true);
    }
  });
});

test('任务目录或 VRM 是符号链接时拒绝清理，并保留链接目标', async () => {
  await withStorage(async ({ temp, roots }) => {
    const linkedId = 'e'.repeat(32);
    const outsideDir = join(temp, 'outside-job');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'marker.txt'), 'keep');
    symlinkSync(outsideDir, join(roots.jobsRoot, linkedId));
    await assert.rejects(deleteFinishedAvatarJob(linkedId, roots), /任务目录不安全/);
    assert.equal(readFileSync(join(outsideDir, 'marker.txt'), 'utf8'), 'keep');

    const vrmId = 'f'.repeat(32);
    const jobDir = makeJob(roots, vrmId, 'complete');
    const outsideVrm = join(temp, 'outside.vrm');
    writeFileSync(outsideVrm, 'keep-vrm');
    symlinkSync(outsideVrm, join(roots.avatarsRoot, `${vrmId}.vrm`));
    await assert.rejects(deleteFinishedAvatarJob(vrmId, roots), /VRM 文件不安全/);
    assert.equal(existsSync(jobDir), true);
    assert.equal(readFileSync(outsideVrm, 'utf8'), 'keep-vrm');
  });
});

test('清空记录只删除已结束任务，并返回保留任务 ID', async () => {
  await withStorage(async ({ roots }) => {
    const imageReady = '1'.repeat(32);
    const failed = '2'.repeat(32);
    const running = '3'.repeat(32);
    const queued = '4'.repeat(32);
    for (const [id, status] of [[imageReady, 'image-ready'], [failed, 'failed'],
      [running, 'running'], [queued, 'queued']]) makeJob(roots, id, status);

    const result = await deleteAllFinishedAvatarJobs(roots);
    assert.deepEqual(result.deletedIds, [imageReady, failed]);
    assert.deepEqual(result.skippedIds, [running, queued]);
    assert.equal(existsSync(join(roots.jobsRoot, running)), true);
    assert.equal(existsSync(join(roots.jobsRoot, queued)), true);
  });
});

test('参考图丢失或越出任务目录时不暴露预览 URL', async () => {
  await withStorage(async ({ temp, roots }) => {
    const id = '5'.repeat(32);
    const dir = makeJob(roots, id, 'image-ready');
    const reference = join(dir, 'tpose.png');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ tpose_ref_image: reference }));
    assert.equal((await readAvatarJob(id, roots.jobsRoot))?.preview_url, undefined);
    writeFileSync(reference, 'image');
    assert.equal((await readAvatarJob(id, roots.jobsRoot))?.preview_url,
      `/api/avatar-jobs/${id}/reference`);
    const outside = join(temp, 'outside.png');
    writeFileSync(outside, 'image');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ tpose_ref_image: outside }));
    assert.equal((await readAvatarJob(id, roots.jobsRoot))?.preview_url, undefined);
  });
});

/**
 * G2 纯逻辑测试（二）：clip 烘焙与录制统计。
 *
 * 全部离线。重点验三件事：
 *   1. 重采样是不是**严格**落在 1/fps 的网格上（不是"大概 30 帧"）
 *   2. 产出的 clip 能不能过 G1 那套冻结的校验规则（不能因为来自摄像头就放宽）
 *   3. 质量指标算得对不对 —— 它决定"这段录制允不允许生成动作"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildClip, samplePoseAt } from '../web/lib/mocap/clip-builder.ts';
import { RecordingSession, checkBuildable } from '../web/lib/mocap/recording.ts';
import { MOCAP_LIMITS } from '../web/lib/mocap/mocap-types.ts';
import { rotQ, BASE_STANDING_POSE } from '../web/lib/pose.ts';
import { CLIP_SPEC, validateClip, FORBIDDEN_CLIP_KEYS } from '../web/lib/clip-spec.ts';

// contracts.ts 会 import JSON（Node 需要 import attributes），所以测试自己读骨骼表，
// 与 tools/validate-clip.mjs 的做法一致。
const BONE_LIST = JSON.parse(
  readFileSync(new URL('../web/lib/human-bones-vrm1.json', import.meta.url), 'utf8'),
);

const D = Math.PI / 180;
/** 从四元数取旋转角（度） */
const quatAngleDeg = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3])))) / D;
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/**
 * 造一段"角度随时间线性增长"的姿态序列。
 *
 * 为什么这样造：纯 Z 轴旋转下，相邻帧的最短路径 slerp 结果**精确**等于角度线性插值，
 * 所以可以拿角度反推"这一帧采样在哪个时刻"，把重采样网格验成精确断言，
 * 而不是"看起来差不多"。
 */
function linearFrames({ durationMs = 2000, stepMs = 33, degPerSec = 40 }) {
  const frames = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    frames.push({
      timestampMs: t,
      pose: { rightUpperArm: rotQ('Z', (degPerSec * t) / 1000) },
    });
  }
  return frames;
}

// ── 1. 重采样必须严格落在 1/fps 网格上 ──────────────────────────────────

test('★ 变帧率输入重采样后严格为 30 FPS', () => {
  // 源帧率刻意不规则：22–47ms 抖动
  const frames = [];
  let t = 0;
  let i = 0;
  const jitter = [22, 41, 33, 47, 28, 35];
  while (t <= 2000) {
    frames.push({ timestampMs: t, pose: { rightUpperArm: rotQ('Z', 40 * (t / 1000)) } });
    t += jitter[i++ % jitter.length];
  }

  const res = buildClip({ name: 'test-resample', frames, inMs: 200, outMs: 1800, boneList: BONE_LIST });
  assert.equal(res.ok, true, `不该失败：${JSON.stringify(res.issues)}`);
  assert.equal(res.stats.fps, CLIP_SPEC.defaultFps);
  assert.equal(res.clip.duration, (res.clip.frameCount - 1) / CLIP_SPEC.defaultFps);
  assert(Number.isInteger(res.clip.frameCount));
  for (const [bone, track] of Object.entries(res.clip.bones)) {
    assert.equal(track.length, res.clip.frameCount, `${bone} 轨道长度必须等于 frameCount`);
  }
});

test('★ 输出第 i 帧确实采样在 inMs + i/fps 处（精确，不是近似）', () => {
  const frames = linearFrames({ durationMs: 2000, stepMs: 11, degPerSec: 40 });
  const inMs = 250;
  const outMs = 1750;
  const res = buildClip({ name: 'test-grid', frames, inMs, outMs, boneList: BONE_LIST });
  assert.equal(res.ok, true);

  const track = res.clip.bones.rightUpperArm;
  const expectedCount = Math.round((outMs - inMs) / (1000 / 30)) + 1;
  assert.equal(res.clip.frameCount, expectedCount);

  for (let i = 0; i < track.length; i++) {
    const expectedDeg = (40 * (inMs + i * (1000 / 30))) / 1000;
    const gotDeg = quatAngleDeg(track[i]);
    assert.ok(
      Math.abs(gotDeg - expectedDeg) < 0.05,
      `第 ${i} 帧角度 ${gotDeg.toFixed(3)}° 与期望 ${expectedDeg.toFixed(3)}° 不符（采样时刻错了）`,
    );
  }
});

test('输出时长与裁剪时长的偏差不超过半帧', () => {
  for (const [inMs, outMs] of [[0, 1200], [100, 900], [0, 500], [333, 1777]]) {
    const res = buildClip({
      name: 'test-drift',
      frames: linearFrames({ durationMs: 2000 }),
      inMs,
      outMs,
      boneList: BONE_LIST,
    });
    assert.equal(res.ok, true, `${inMs}-${outMs} 失败`);
    assert.ok(
      res.stats.durationDriftMs <= 1000 / 30 / 2 + 1e-6,
      `裁剪 ${inMs}-${outMs} 偏差 ${res.stats.durationDriftMs.toFixed(2)}ms 超过半帧`,
    );
  }
});

test('采样不外推：区间外的时刻取端点，不造出原视频里没有的姿态', () => {
  const frames = linearFrames({ durationMs: 1000 });
  const first = frames[0].pose.rightUpperArm;
  const last = frames[frames.length - 1].pose.rightUpperArm;
  assert.ok(maxDiff(samplePoseAt(frames, -5000, ['rightUpperArm']).rightUpperArm, first) < 1e-12);
  assert.ok(maxDiff(samplePoseAt(frames, 999999, ['rightUpperArm']).rightUpperArm, last) < 1e-12);
});

// ── 2. 裁剪边界 ────────────────────────────────────────────────────────

test('裁剪区间短于 0.5 秒必须拒绝，并说清原因', () => {
  const res = buildClip({
    name: 'test-short',
    frames: linearFrames({ durationMs: 1000 }),
    inMs: 0,
    outMs: MOCAP_LIMITS.minTrimMs - 1,
    boneList: BONE_LIST,
  });
  assert.equal(res.ok, false);
  assert.equal(res.clip, null, '失败时绝不能返回半成品 clip');
  assert.equal(res.issues[0].rule, 'BUILD_TOO_SHORT');
});

test('出点小于等于入点必须拒绝', () => {
  const res = buildClip({
    name: 'test-bad-range',
    frames: linearFrames({ durationMs: 1000 }),
    inMs: 800,
    outMs: 400,
    boneList: BONE_LIST,
  });
  assert.equal(res.ok, false);
  assert.equal(res.issues[0].rule, 'BUILD_RANGE');
});

test('空帧序列 / 空名字必须拒绝', () => {
  assert.equal(buildClip({ name: 'x', frames: [], inMs: 0, outMs: 1000 }).ok, false);
  assert.equal(
    buildClip({ name: '', frames: linearFrames({}), inMs: 0, outMs: 1000 }).ok,
    false,
  );
});

test('裁剪只取区间内的内容：入点前的姿态不出现在结果里', () => {
  const frames = linearFrames({ durationMs: 2000, degPerSec: 40 });
  const res = buildClip({ name: 'test-trim', frames, inMs: 1000, outMs: 1500, boneList: BONE_LIST });
  assert.equal(res.ok, true);
  const track = res.clip.bones.rightUpperArm;
  // 入点 1000ms → 起始角 40°，末帧约 1500ms → 60°
  assert.ok(Math.abs(quatAngleDeg(track[0]) - 40) < 0.1, `首帧 ${quatAngleDeg(track[0])}`);
  assert.ok(Math.abs(quatAngleDeg(track[track.length - 1]) - 60) < 0.6);
});

// ── 3. 四元数符号连续 ─────────────────────────────────────────────────

test('★ 符号连续化：输入里交替取负，输出里不得再有符号跳变', () => {
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const q = rotQ('Z', i * 2);
    // 故意每隔一帧取负 —— 表示同一个旋转，但相邻帧点积为负
    frames.push({ timestampMs: i * 33, pose: { rightUpperArm: i % 2 ? q.map((v) => -v) : q } });
  }
  const res = buildClip({ name: 'test-signs', frames, inMs: 0, outMs: 1900, boneList: BONE_LIST });
  assert.equal(res.ok, true);

  const track = res.clip.bones.rightUpperArm;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  for (let i = 1; i < track.length; i++) {
    assert.ok(dot(track[i - 1], track[i]) >= 0, `第 ${i} 帧出现符号跳变`);
  }
  assert.ok(res.stats.signFlipsFixed > 0, '应当报告修复过符号跳变');
});

test('符号取负不改变动作本身（q 与 −q 是同一个旋转）', () => {
  const a = [];
  const b = [];
  for (let i = 0; i < 40; i++) {
    const q = rotQ('Z', i * 3);
    a.push({ timestampMs: i * 33, pose: { rightUpperArm: q } });
    b.push({ timestampMs: i * 33, pose: { rightUpperArm: q.map((v) => -v) } });
  }
  const ra = buildClip({ name: 'a', frames: a, inMs: 0, outMs: 1200, boneList: BONE_LIST });
  const rb = buildClip({ name: 'b', frames: b, inMs: 0, outMs: 1200, boneList: BONE_LIST });
  assert.equal(ra.ok && rb.ok, true);
  const ta = ra.clip.bones.rightUpperArm;
  const tb = rb.clip.bones.rightUpperArm;
  for (let i = 0; i < ta.length; i++) {
    const d = Math.abs(ta[i][0] * tb[i][0] + ta[i][1] * tb[i][1] + ta[i][2] * tb[i][2] + ta[i][3] * tb[i][3]);
    assert.ok(Math.abs(d - 1) < 1e-5, `第 ${i} 帧代表的旋转不同`);
  }
});

// ── 4. 产出的 clip 必须过冻结的那套规则 ────────────────────────────────

test('★ 生成的 clip 通过全部现有校验规则（不因为是摄像头来的就放宽）', () => {
  const res = buildClip({
    name: 'mocap-test-pass',
    frames: linearFrames({ durationMs: 2000, stepMs: 29 }),
    inMs: 100,
    outMs: 1900,
    boneList: BONE_LIST,
    targetBones: BONE_LIST,
  });
  assert.equal(res.ok, true, JSON.stringify(res.issues, null, 2));
  const v = validateClip(res.clip, { boneList: BONE_LIST, targetBones: BONE_LIST });
  assert.equal(v.errors, 0, JSON.stringify(v.issues.filter((i) => i.level === 'ERROR'), null, 2));
  assert.equal(v.ok, true);
});

test('产出的 clip 不含任何禁用键（根位移/缩放/表情/弹簧骨）', () => {
  const res = buildClip({
    name: 'mocap-test-keys',
    frames: linearFrames({ durationMs: 1000 }),
    inMs: 0,
    outMs: 1000,
    boneList: BONE_LIST,
  });
  assert.equal(res.ok, true);
  for (const forbidden of FORBIDDEN_CLIP_KEYS) {
    assert.ok(!(forbidden in res.clip), `clip 里不该出现 ${forbidden}`);
  }
});

test('产出的 clip 不带 G2 专属字段（格式没有被污染）', () => {
  const res = buildClip({
    name: 'mocap-test-clean',
    frames: linearFrames({ durationMs: 1000 }),
    inMs: 0,
    outMs: 1000,
    boneList: BONE_LIST,
  });
  assert.equal(res.ok, true);
  const allowed = new Set([
    'schemaVersion', 'rigProfile', 'name', 'space', 'rotationMode',
    'quaternionOrder', 'fps', 'frameCount', 'duration', 'loop', 'rootMotion', 'mask', 'bones',
  ]);
  for (const k of Object.keys(res.clip)) {
    assert.ok(allowed.has(k), `clip 里出现了计划外字段 ${k}（录制来源与质量应放 MocapCaptureV1）`);
  }
});

test('mask 与 bones 的键集合完全一致（顺序无关）', () => {
  const res = buildClip({
    name: 'mocap-test-mask',
    frames: linearFrames({ durationMs: 800 }),
    inMs: 0,
    outMs: 800,
    boneList: BONE_LIST,
  });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.clip.mask].sort(), Object.keys(res.clip.bones).sort());
});

test('多骨骼输入：并集被完整取到，且各自独立重采样', () => {
  const frames = [];
  for (let i = 0; i < 50; i++) {
    frames.push({
      timestampMs: i * 30,
      pose: {
        rightUpperArm: rotQ('Z', i),
        leftUpperArm: rotQ('Z', -i),
        ...(i >= 10 ? { head: rotQ('Y', i / 2) } : {}), // 故意从第 10 帧才出现 head
      },
    });
  }
  const res = buildClip({ name: 'mocap-multi', frames, inMs: 0, outMs: 1470, boneList: BONE_LIST });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.clip.bones).sort(), ['head', 'leftUpperArm', 'rightUpperArm']);
});

// ── 5. 录制统计 ───────────────────────────────────────────────────────

test('★★ 帧时间戳是【绝对】时刻时也必须烘出动作（相对 in/out 的口径换算）', () => {
  // 复盘：`inMs`/`outMs` 的契约是"相对录制起点"，而页面传进来的
  // `frames[].timestampMs` 是 `performance.now()` 的**绝对**时刻（几十万毫秒）。
  // 早先 buildClip 把相对值直接当绝对用，于是 samplePoseAt 的边界分支
  // 对每一帧都返回 frames[0] —— 整段 clip 变成一张静止照片。
  //
  // 它在生产路径上活了很久，三次真人录制全是 0.0000° 变化的 clip，
  // 而测试全绿：因为夹具用的是 0/33/66… 这种小时间戳，
  // 恰好落在"两种口径重合"的区间里，**测不出来**。
  //
  // 所以这条测试刻意用真实量级的时间戳（开页 8 分钟后录制）。
  const T0 = 503_169; // 实测值：mocap-20260922-201528 的首帧时间戳
  const frames = [];
  for (let i = 0; i < 40; i++) {
    frames.push({
      timestampMs: T0 + i * 33,
      pose: { rightUpperArm: rotQ('Z', (40 * i) / 39) }, // 每帧都在动
    });
  }

  const res = buildClip({ name: 'absolute-ts', frames, inMs: 0, outMs: 33 * 39, boneList: BONE_LIST, targetBones: BONE_LIST });
  assert.equal(res.ok, true, res.ok ? '' : res.issues.map((x) => x.msg).join('; '));

  const track = res.clip.bones.rightUpperArm;
  assert.ok(track, '没有 rightUpperArm 轨道');
  const maxDiff = (a, b) =>
    2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * (180 / Math.PI);
  let maxStep = 0;
  for (let i = 1; i < track.length; i++) maxStep = Math.max(maxStep, maxDiff(track[i - 1], track[i]));
  assert.ok(maxStep > 0.5, `clip 被冻住了：最大单帧变化仅 ${maxStep.toFixed(4)}°`);
  assert.ok(maxDiff(track[0], track[track.length - 1]) > 20, '首末帧几乎没有差别');

  // 帧数与时长仍按【相对】区间算，不能被绝对口径带偏
  assert.equal(res.clip.frameCount, 40);
  assert.ok(Math.abs(res.clip.duration - 39 / 30) < 1e-9, `时长算错：${res.clip.duration}`);
});

function mkRecFrame(t, { tracked = true, lost = [] } = {}) {
  return { timestampMs: t, pose: { ...BASE_STANDING_POSE }, tracked, lostBones: lost };
}

test('录制统计：有效帧占比 / 最长丢失段 / 推理帧率', () => {
  const s = new RecordingSession();
  s.start(0);
  // 30fps 共 300 帧 = 10 秒；其中每 10 帧丢 1 帧
  for (let i = 0; i < 300; i++) {
    const bad = i % 10 === 0;
    s.add(mkRecFrame(i * (1000 / 30), { tracked: !bad, lost: bad ? ['rightUpperArm'] : [] }));
  }
  const out = s.stop(300 * (1000 / 30) - 1000 / 30);

  assert.equal(out.frames.length, 300);
  assert.ok(Math.abs(out.stats.inferenceFps - 30) < 0.5, `推理帧率 ${out.stats.inferenceFps}`);
  assert.ok(Math.abs(out.stats.durationMs - 9966.7) < 20, `时长 ${out.stats.durationMs}`);
  assert.ok(out.stats.validFrameRatio > 0.0 && out.stats.validFrameRatio < 1);
  assert.equal(out.stats.lostBoneCount, 1);
  // 每 10 帧丢 1 帧 → 单帧丢失，时长约 33ms
  assert.ok(out.stats.longestTrackingGapMs > 0);
});

test('★ 录制：超过 500ms 的丢失段被正确测出并给出警告', () => {
  const s = new RecordingSession();
  s.start(0);
  let t = 0;
  for (let i = 0; i < 30; i++) {
    s.add(mkRecFrame(t));
    t += 33;
  }
  // 连续 700ms 身体丢失
  for (let i = 0; i < 21; i++) {
    s.add(mkRecFrame(t, { tracked: false }));
    t += 33;
  }
  for (let i = 0; i < 40; i++) {
    s.add(mkRecFrame(t));
    t += 33;
  }
  const out = s.stop(t);

  assert.ok(out.stats.longestTrackingGapMs >= 690, `最长丢失段 ${out.stats.longestTrackingGapMs}ms 应约 700ms`);
  assert.ok(
    out.quality.warnings.some((w) => w.includes('跟踪丢失段')),
    `应有丢失段警告，实际 ${JSON.stringify(out.quality.warnings)}`,
  );
});

test('★ 录制：有效帧不足 70% 时禁止生成 clip', () => {
  const s = new RecordingSession();
  s.start(0);
  let t = 0;
  for (let i = 0; i < 100; i++) {
    s.add(mkRecFrame(t, { tracked: i % 2 === 0 })); // 只有 50% 有效
    t += 33;
  }
  const out = s.stop(t);
  assert.ok(out.stats.validFrameRatio < 0.7, `有效帧 ${out.stats.validFrameRatio}`);
  assert.equal(out.canBuildClip, false);
  assert.equal(checkBuildable(out.quality).ok, false);
  assert.ok(out.quality.warnings.some((w) => w.includes('不允许生成动作')));
});

test('录制：恰好 70% 有效时允许生成', () => {
  const s = new RecordingSession();
  s.start(0);
  let t = 0;
  for (let i = 0; i < 100; i++) {
    s.add(mkRecFrame(t, { tracked: i % 10 !== 0 })); // 90%
    t += 33;
  }
  const out = s.stop(t);
  assert.equal(out.stats.validFrameRatio, 0.9);
  assert.equal(out.canBuildClip, true);
  assert.equal(checkBuildable(out.quality).ok, true);
  assert.equal(checkBuildable(out.quality).reason, null);
});

test('录制：10 秒上限会被识别（页面据此自动停）', () => {
  const s = new RecordingSession();
  s.start(0);
  let t = 0;
  for (let i = 0; i < 290; i++) {
    s.add(mkRecFrame(t));
    t += 33;
  }
  assert.equal(s.isFull, false);
  for (let i = 0; i < 20; i++) {
    s.add(mkRecFrame(t));
    t += 33;
  }
  assert.equal(s.isFull, true, `时长 ${s.durationMs}ms 应已超过 ${MOCAP_LIMITS.maxRecordingMs}ms`);
});

test('录制：停止后不再收帧（防止 stop 之后还有回调写进来）', () => {
  const s = new RecordingSession();
  s.start(0);
  s.add(mkRecFrame(0));
  s.add(mkRecFrame(33));
  s.stop(66);
  s.add(mkRecFrame(99));
  assert.equal(s.frameCount, 2);
  assert.equal(s.isRecording, false);
});

test('录制：未闭合的丢失段在 stop 时收尾', () => {
  const s = new RecordingSession();
  s.start(0);
  s.add(mkRecFrame(0));
  s.add(mkRecFrame(33, { tracked: false }));
  const out = s.stop(500);
  assert.ok(out.stats.longestTrackingGapMs >= 460, `未闭合丢失段应算到 stop 时刻：${out.stats.longestTrackingGapMs}`);
});

test('录制：时长为 0 时推理帧率记 0 而不是 Infinity', () => {
  const s = new RecordingSession();
  s.start(1000);
  s.add(mkRecFrame(1000));
  assert.equal(s.stats().inferenceFps, 0);
});

test('录制的帧可以直接喂给 buildClip（两段接口能接上）', () => {
  const s = new RecordingSession();
  s.start(0);
  for (let i = 0; i < 120; i++) {
    s.add({ timestampMs: i * 33, pose: { rightUpperArm: rotQ('Z', i) }, tracked: true, lostBones: [] });
  }
  const out = s.stop(120 * 33);
  const res = buildClip({
    name: 'mocap-e2e',
    frames: out.frames,
    inMs: 100,
    outMs: out.stats.durationMs - 100,
    boneList: BONE_LIST,
  });
  assert.equal(res.ok, true, JSON.stringify(res.issues));
  assert.equal(res.stats.sourceFrameCount, 120);
});

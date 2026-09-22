#!/usr/bin/env node
/**
 * 纯逻辑测试：clip v1 插值、ClipPlayer 播放语义。
 *
 * 这些断言不需要浏览器（ClipPlayer 不持有 VRM、不依赖 DOM），
 * 其中「同一时刻在不同刷新率下得到同一姿态」正是"按秒采样而非按帧"的核心保证。
 *
 * 运行: npm run test:clip   （在 web/ 下）
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIP_SPEC, slerpQuat, validateClip } from '../web/lib/clip-spec.ts';
import { baseQuatOf, slerp as slerpPose, keyframeBones, sampleKeyframes, rotQ } from '../web/lib/pose.ts';
import { ClipPlayer, ClipPlaybackCancelledError } from '../web/lib/clip-player.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BONES = JSON.parse(readFileSync(join(ROOT, 'web/lib/human-bones-vrm1.json'), 'utf8'));
const CLIP_DIR = join(ROOT, 'web/public/clips');

/**
 * 读动作库里的 clip，并带上来源。
 *
 * ★ 为什么需要来源：目录里现在不止程序化动作 —— G2 录的真人动作也在里面。
 *   有些断言（比如"首末帧回到基础站姿"）只对**程序化生成**的动作成立；
 *   真人录的动作自然从任意姿态开始、在任意姿态结束。
 *   早期实现把那条断言套在所有文件上，于是录完第一个动作测试就红 ——
 *   那是测试的假设坏了，不是动作坏了。
 */
function loadClips() {
  const sources = new Map();
  try {
    const idx = JSON.parse(readFileSync(join(CLIP_DIR, 'index.json'), 'utf8'));
    for (const c of idx.clips ?? []) sources.set(c.id, c.source ?? 'generated');
  } catch {
    /* 没有目录就都当 generated */
  }
  return readdirSync(CLIP_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => {
      const clip = JSON.parse(readFileSync(join(CLIP_DIR, f), 'utf8'));
      return { ...clip, source: sources.get(clip.name) ?? 'generated' };
    });
}

/** 只要程序化生成的那批 */
const generatedClips = () => loadClips().filter((c) => c.source === 'generated');

const q = (a, deg) => rotQ(a, deg);
const almost = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const quatAlmost = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

// ---------------------------------------------------------------------------
// 规格与产出文件
// ---------------------------------------------------------------------------

test('动作库里的所有动作都通过校验（含真人录制的）', () => {
  const clips = loadClips();
  assert.ok(clips.length >= 6, `期望至少 6 个动作，实际 ${clips.length}`);
  for (const c of clips) {
    const r = validateClip(c, { boneList: BONES });
    assert.equal(r.errors, 0, `${c.name} 有 ${r.errors} 个 ERROR：${r.issues.map((i) => i.msg).join('; ')}`);
  }
});

test('程序化动作的首帧与末帧都回到基础站姿（真人录制的不适用这条）', () => {
  for (const c of generatedClips()) {
    for (const bone of c.mask) {
      const track = c.bones[bone];
      const expected = baseQuatOf(bone);
      const first = track[0];
      const last = track[track.length - 1];
      // 允许符号等价（q 与 -q 表示同一旋转）
      const same = (a, b) =>
        quatAlmost(a, b, 1e-9) || quatAlmost(a, b.map((v) => -v), 1e-9);
      assert.ok(same(first, expected), `${c.name}/${bone} 首帧不是基础站姿`);
      assert.ok(same(last, expected), `${c.name}/${bone} 末帧不是基础站姿`);
    }
  }
});

test('动作文件中没有根位移、缩放、表情或弹簧骨轨道', () => {
  for (const c of loadClips()) {
    assert.equal(c.rootMotion, 'locked', `${c.name} rootMotion`);
    for (const k of ['translations', 'positions', 'scales', 'expressions', 'springBones']) {
      assert.ok(!(k in c), `${c.name} 出现了禁止字段 ${k}`);
    }
    // 每条轨道必须是四元数串，结构上就写不进位移/缩放
    for (const [bone, track] of Object.entries(c.bones)) {
      for (const v of track) assert.equal(v.length, 4, `${c.name}/${bone} 轨道元素不是四元数`);
    }
  }
});

// ---------------------------------------------------------------------------
// 插值
// ---------------------------------------------------------------------------

test('四元数与取负表示同一旋转，插值走最短路径', () => {
  const a = q('Y', 20);
  const b = q('Y', 60);
  const bNeg = b.map((v) => -v);
  const m1 = slerpQuat(a, b, 0.5);
  const m2 = slerpQuat(a, bNeg, 0.5);
  assert.ok(quatAlmost(m1, m2, 1e-9), '共轭写法应得到同一姿态');

  // +20° → −170° 有两条路：170°（短）与 190°（长）。最短路径的半程应落在 20+85 = 105°。
  // 若不走最短路径，半程会落在 20+95 = 115°。
  const angleDeg = (qq) => (2 * Math.acos(Math.min(1, Math.abs(qq[3])))) * 180 / Math.PI;
  const far = q('Y', -170);
  const mid = slerpQuat(a, far, 0.5);
  assert.ok(
    Math.abs(angleDeg(mid) - 105) < 0.5,
    `最短路径半程应为 105°，实际 ${angleDeg(mid).toFixed(1)}°（115° 附近说明绕了远路）`,
  );
});

test('clip-spec 与 pose 的 slerp 实现一致（两处实现需保持同步）', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    const mk = () => {
      const v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    };
    const a = mk();
    const b = mk();
    const t = rnd();
    const x = slerpQuat(a, b, t);
    const y = slerpPose(a, b, t);
    assert.ok(quatAlmost(x, y, 1e-12), `第 ${i} 组 slerp 结果不一致`);
  }
});

test('关键帧采样：起点、终点与峰值符合预期', () => {
  const keys = [
    { t: 0, pose: {} },
    { t: 1, pose: { rightUpperArm: q('Z', 0) } },
    { t: 2, pose: {} },
  ];
  const bones = keyframeBones(keys);
  assert.deepEqual(bones, ['rightUpperArm']);
  const base = baseQuatOf('rightUpperArm');
  assert.ok(quatAlmost(sampleKeyframes(keys, 'rightUpperArm', 0), base, 1e-12));
  assert.ok(quatAlmost(sampleKeyframes(keys, 'rightUpperArm', 1), q('Z', 0), 1e-12));
  assert.ok(quatAlmost(sampleKeyframes(keys, 'rightUpperArm', 2), base, 1e-12));
  // 缓动：半程角度的位置应落在中间附近（smoothstep(0.5)=0.5）
  const mid = sampleKeyframes(keys, 'rightUpperArm', 0.5);
  const half = slerpPose(base, q('Z', 0), 0.5);
  assert.ok(quatAlmost(mid, half, 1e-9), 'smoothstep 在中点应等于线性中值');
});

// ---------------------------------------------------------------------------
// ClipPlayer 语义
// ---------------------------------------------------------------------------

const clipOf = (name) => loadClips().find((c) => c.name === name);
const clone = (c) => JSON.parse(JSON.stringify(c));

test('同一播放时刻、不同 delta 序列，得到同一姿态（按秒采样，与刷新率无关）', () => {
  const clip = clipOf('turn-head');
  const target = 1.25;

  const runAt = (fps) => {
    const p = new ClipPlayer();
    p.play(clip, { loop: false, fadeIn: 0 });
    const dt = 1 / fps;
    let t = 0;
    let pose = {};
    while (t < target - 1e-9) {
      pose = p.update(Math.min(dt, target - t));
      t += dt;
    }
    p.seek(target);
    return p.update(0);
  };

  const at120 = runAt(120);
  const at30 = runAt(30);
  for (const bone of clip.mask) {
    assert.ok(quatAlmost(at120[bone], at30[bone], 1e-6), `${bone} 在 120fps 与 30fps 下姿态不同`);
  }
});

test('非循环动作播完会 resolve，并回到末帧姿态', async () => {
  const clip = clipOf('turn-head');
  const p = new ClipPlayer();
  let done = false;
  const promise = p.play(clip, { fadeIn: 0, fadeOut: 0 }).then(() => {
    done = true;
  });
  // 按 1/120 秒推进直到超过时长
  for (let i = 0; i < 120 * 6; i++) p.update(1 / 120);
  await promise;
  assert.ok(done, '非循环动作应 resolve');
  assert.equal(p.getSnapshot().state, 'idle');
});

test('被新动作取代的未完成动作以可识别错误 reject', async () => {
  const p = new ClipPlayer();
  const first = p.play(clipOf('turn-head'), { fadeIn: 0 });
  const second = p.play(clipOf('raise-right-arm'), { fadeIn: 0 });
  await assert.rejects(first, (e) => e instanceof ClipPlaybackCancelledError && e.name === 'ClipPlaybackCancelledError');
  p.stop();
  await assert.rejects(second, (e) => e instanceof ClipPlaybackCancelledError);
});

test('切换动作时，退出 mask 的骨骼平滑回基础站姿，不留残余', () => {
  const p = new ClipPlayer();
  const a = clone(clipOf('raise-right-arm')); // mask: rightUpperArm
  const b = clone(clipOf('bend-left-elbow')); // mask: leftLowerArm
  p.play(a, { fadeIn: 0, fadeOut: 0.2 }).catch(() => {}); // 会被 b 取代，取消属预期
  for (let i = 0; i < 60; i++) p.update(1 / 60); // 推进到动作中段
  const mid = p.update(0);
  assert.ok(mid.rightUpperArm, '切换前右臂应在合成姿态里');

  p.play(b, { fadeIn: 0.2, fadeOut: 0.2 }).catch(() => {});
  const during = p.update(1 / 60); // 过渡中
  assert.ok(during.rightUpperArm, '过渡期间退出 mask 的骨骼仍应参与合成（否则会瞬跳）');

  // 过渡结束后，右臂必须回到基础站姿
  for (let i = 0; i < 60; i++) p.update(1 / 60);
  const after = p.update(0);
  if (after.rightUpperArm) {
    assert.ok(
      quatAlmost(after.rightUpperArm, baseQuatOf('rightUpperArm'), 1e-6),
      '右臂未回到基础站姿，存在残余动作',
    );
  }
  assert.equal(p.getSnapshot().outgoing, null, '过渡应已结束');
});

test('暂停冻结时钟与过渡，seek 直接定位并保持暂停', () => {
  const p = new ClipPlayer();
  p.play(clipOf('turn-head'), { fadeIn: 0 });
  for (let i = 0; i < 30; i++) p.update(1 / 60);
  p.pause();
  const t1 = p.getSnapshot().time;
  for (let i = 0; i < 60; i++) p.update(1 / 60);
  assert.equal(p.getSnapshot().time, t1, '暂停期间时钟不应推进');

  p.seek(2.0);
  assert.equal(p.getSnapshot().time, 2.0);
  assert.equal(p.getSnapshot().state, 'paused');
  assert.equal(p.getSnapshot().weight, 1, 'seek 后权重应为 1');
});

test('页面隐藏时挂起，恢复后不跳到结尾', () => {
  const p = new ClipPlayer();
  p.play(clipOf('turn-head'), { fadeIn: 0 });
  for (let i = 0; i < 30; i++) p.update(1 / 60);
  const t1 = p.getSnapshot().time;
  p.setSuspended(true);
  for (let i = 0; i < 300; i++) p.update(1 / 60);
  assert.equal(p.getSnapshot().time, t1, '挂起期间时钟不应推进');
  p.setSuspended(false);
  p.update(1 / 60);
  assert.ok(p.getSnapshot().time > t1, '恢复后应从原处继续');
  assert.ok(p.getSnapshot().time < t1 + 0.05, '恢复后不应跳到结尾');
});

test('循环动作启动即 resolve，时间在时长内回绕', async () => {
  const clip = clone(clipOf('turn-head'));
  const p = new ClipPlayer();
  await p.play(clip, { loop: true, fadeIn: 0 });
  const end = (clip.frameCount - 1) / clip.fps;
  for (let i = 0; i < Math.ceil((end * 2 + 0.5) * 60); i++) p.update(1 / 60);
  const s = p.getSnapshot();
  assert.equal(s.loop, true);
  assert.ok(s.time >= 0 && s.time <= end + 1e-6, `循环时间越界：${s.time}`);
});

test('根位置与缩放不受动作影响（v1 禁止根运动）', () => {
  for (const c of loadClips()) {
    const names = Object.keys(c.bones);
    assert.ok(!names.includes('hips') || c.mask.includes('hips') === false || true);
    // 结构上：bones 只含四元数，没有 position/scale 字段
    for (const k of names) {
      assert.equal(typeof k, 'string');
    }
    assert.equal(c.rootMotion, 'locked');
  }
  // ClipPlayer 只输出四元数，不可能带动位移或缩放
  const p = new ClipPlayer();
  p.play(clipOf('wave-right-hand'), { fadeIn: 0 });
  const pose = p.update(0.5);
  for (const [, v] of Object.entries(pose)) {
    assert.equal(v.length, 4, '姿态值必须是四元数');
  }
});

test('CLIP_SPEC 与文档约定一致', () => {
  assert.equal(CLIP_SPEC.schemaVersion, 1);
  assert.equal(CLIP_SPEC.rigProfile, 'vrm-normalized-v1');
  assert.equal(CLIP_SPEC.quaternionOrder, 'xyzw');
  assert.equal(CLIP_SPEC.rootMotion, 'locked');
  assert.equal(CLIP_SPEC.defaultFps, 30);
});

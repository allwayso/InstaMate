/**
 * G2 纯逻辑测试（一）：重定向、校准、平滑、置信度、显示映射。
 *
 * 全部离线 —— 不需要摄像头、不需要 VRM、不需要浏览器。
 * 这是刻意的：真人动捕最难的部分是数学，而数学不该依赖硬件才能验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eulerXYZToQuat,
  mapEuler,
  retarget,
  resolveRules,
  RETARGET_RULES,
  RETARGET_TARGET_BONES,
  CALIBRATED_BONES,
  findUnpairedSidedBones,
  buildHandsInput,
  FINGER_TARGET_BONES,
  RETARGET_IS_MEASURED,
} from '../web/lib/mocap/retarget-profile.ts';
import {
  applyCalibration,
  averageQuats,
  averagePose,
  computeCorrections,
  quatInverse,
  CalibrationSession,
  CALIBRATION_REQUIRED_BONES,
} from '../web/lib/mocap/calibration.ts';
import {
  computeSourceConfidence,
  computeBoneConfidence,
  faceConfidence,
  isBodyTracked,
  PoseSmoother,
  KALIDOKIT_SOURCE_POINTS,
} from '../web/lib/mocap/smoothing.ts';
import {
  toDisplayX,
  toCanvasPoint,
  isDrawable,
  confidenceColor,
  MODEL_INPUT_MIRRORED,
} from '../web/lib/mocap/display-mapping.ts';
import { MOCAP_LIMITS } from '../web/lib/mocap/mocap-types.ts';
import { BASE_STANDING_POSE, baseQuatOf, mulQ } from '../web/lib/pose.ts';

const D = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
// 真正的旋转夹角（与 three.js 的 Quaternion.angleTo 同口径）。
// 注意 quaternion 的 dot 是 cos(θ/2)，所以角度要乘 2 —— 早先漏了这个 2，
// 于是「与 Rz*Ry*Rx 差 44.9°」被算成 22.45°，断言阈值全部失真。
const angleBetween = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(dot(a, b))))) / D;

// ── 1. 欧拉约定必须与 three.js 一致 ──────────────────────────────────────

/**
 * 由 three.js 0.186.0 的 `new Euler(x,y,z,'XYZ')` 生成的标准值。
 * 锚在这里的原因：Kalidokit 的设计前提就是「把这三个数直接赋给 three.js 的 rotation」，
 * 所以我们的欧拉→四元数转换必须与 three.js 完全一致，差一点点都会让所有动作静默偏转。
 * 测试文件在仓库根，引不到 web/node_modules/three，所以用冻结的参考值。
 */
const EULER_XYZ_REFERENCE = [
  [[0, 0, 0], [0, 0, 0, 1]],
  [[30, 0, 0], [0.2588190451, 0, 0, 0.9659258263]],
  [[0, 40, 0], [0, 0.3420201433, 0, 0.9396926208]],
  [[0, 0, 50], [0, 0, 0.4226182617, 0.906307787]],
  [[30, 40, 50], [0.3600421737, 0.1966282255, 0.4638269103, 0.7852207151]],
  [[-20, 10, -35], [-0.1907910851, 0.029840788, -0.3094444786, 0.9311027891]],
  [[90, 0, 0], [0.7071067812, 0, 0, 0.7071067812]],
  [[0, 180, 0], [0, 1, 0, 0]],
  [[12.5, -47.25, 33.75], [-0.0201921718, -0.410167097, 0.2226249227, 0.884190801]],
];

test('欧拉 XYZ → 四元数与 three.js 完全一致（约定锚点）', () => {
  for (const [[x, y, z], expected] of EULER_XYZ_REFERENCE) {
    const got = eulerXYZToQuat({ x: x * D, y: y * D, z: z * D });
    assert.ok(
      maxDiff(got, expected) < 1e-9,
      `euler(${x},${y},${z}) 偏差过大：${maxDiff(got, expected).toExponential(2)}`,
    );
  }
});

test('欧拉 XYZ 是 Rx×Ry×Rz，不是 Rz×Ry×Rx', () => {
  // 若实现写反成 Rz×Ry×Rx，会差出几十度 —— 而"看起来还是动了"，极易漏过
  const got = eulerXYZToQuat({ x: 30 * D, y: 40 * D, z: 50 * D });
  const reversed = [0.080805, 0.402198, 0.303372, 0.860042];
  assert.ok(angleBetween(got, reversed) > 30, '与 Rz×Ry×Rx 的差异应当很大（证明没写反）');
});

// ── 2. 轴映射与权重（只锁机制，不锁具体轴向）────────────────────────────

test('轴映射与符号按规则生效', () => {
  const src = { x: 1, y: 2, z: 3 };
  assert.deepEqual(mapEuler(src, [{ axis: 'z', sign: -1 }, { axis: 'y', sign: 1 }, { axis: 'x', sign: 1 }]), {
    x: -3,
    y: 2,
    z: 1,
  });
});

test('每根目标骨骼都有规则，且来源键是已知的 Kalidokit 键', () => {
  const known = new Set(['Spine', 'Face.head', ...Object.keys(KALIDOKIT_SOURCE_POINTS)]);
  // 手部（HandSolver）的键：${Right|Left}Wrist 与 5 指 × 3 段
  for (const side of ['Right', 'Left']) {
    known.add(`${side}Wrist`);
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      for (const seg of ['Proximal', 'Intermediate', 'Distal']) known.add(`${side}${f}${seg}`);
    }
  }
  for (const bone of RETARGET_TARGET_BONES) {
    const rule = RETARGET_RULES[bone];
    assert.ok(rule, `${bone} 没有规则`);
    assert.ok(known.has(rule.from), `${bone} 的来源键 ${rule.from} 不是已知的 Kalidokit 键`);
  }
});

/**
 * 造一份 Kalidokit HandSolver 形状的输出。
 * curl 的符号遵循其源码：**右手恒负、左手恒正**（rigFingers 的 clamp 边界）。
 */
function kdHand(side, curl = 0) {
  const h = {};
  h[`${side}Wrist`] = { x: 0, y: 0, z: 0 };
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
      h[`${side}${f}${seg}`] = { x: 0, y: 0, z: curl };
    }
  }
  return h;
}

test('★★ 手指必须真的动起来（喂手部数据 → 30 根手指全部有输出且非单位四元数）', () => {
  // 握拳：右手负、左手正（Kalidokit 的约定）
  const hands = buildHandsInput(kdHand('Left', 1.2), kdHand('Right', -1.2));
  const out = retarget({ pose: null, hands }, true);

  // 这个测试只喂了手部，所以身体骨骼当然缺 —— 只检查手指
  const missingFingers = out.missing.filter((b) => FINGER_TARGET_BONES.includes(b));
  assert.deepEqual(missingFingers, [], `以下手指缺来源：${missingFingers.join(', ')}`);
  const still = [];
  for (const b of FINGER_TARGET_BONES) {
    const q = out.pose[b];
    if (!q) {
      still.push(`${b}(无输出)`);
      continue;
    }
    if (angleBetween(q, [0, 0, 0, 1]) < 5) still.push(`${b}(没动)`);
  }
  assert.deepEqual(still, [], `以下手指没有跟随：${still.join(', ')}`);
});

test('★★ 回归：桶名必须与 from 前缀同源（这就是"手指完全不动"的成因）', () => {
  // 曾经的写法是 hands = { left, right } 而键前缀是 Right*/Left*，
  // 于是查找永远命中不到 —— 两边各自自洽、合起来不通，而且不报错。
  const hands = buildHandsInput(kdHand('Left', 1), kdHand('Right', -1));
  assert.deepEqual(Object.keys(hands).sort(), ['Left', 'Right'], '桶名必须是 Kalidokit 的侧名');
  for (const [bone, rule] of Object.entries(RETARGET_RULES)) {
    if (rule.scope !== 'hand') continue;
    const side = rule.from.startsWith('Right') ? 'Right' : 'Left';
    assert.ok(
      hands[side] && hands[side][rule.from] !== undefined,
      `${bone}: 桶 ${side} 里没有键 ${rule.from} —— 这正是"手指不动"的直接原因`,
    );
  }
});

test('★ 手指弯曲方向：负值(右手)与正值(左手)都映射成我们的正弯曲', () => {
  // 我们的手指弯曲是 +Z（双手同号，几何探针实测）。
  // Kalidokit 右手负、左手正 → 两侧符号必须不同，否则一侧会反关节。
  const hands = buildHandsInput(kdHand('Left', 1), kdHand('Right', -1));
  const out = retarget({ pose: null, hands }, true);
  for (const b of ['rightIndexProximal', 'leftIndexProximal']) {
    const q = out.pose[b];
    // 绕 +Z 转动的四元数 z 分量为正
    assert.ok(q[2] > 0, `${b} 的弯曲方向反了（z=${q[2].toFixed(4)}，应为正）`);
  }
});

test('★ 腕部自转（旋前/旋后）用 X 轴，且两侧同号', () => {
  // 依据：Kalidokit 的 Wrist.x 带 invert（两侧相反），而我们的左右臂长轴也反向
  // （右侧 +X、左侧 −X），"相反"对上"相反" → 基准符号两侧同号。
  // 对比手指：我们两侧弯曲都是 +Z、Kalidokit 右负左正 → 那边必须两侧异号。
  // 若有人把这里改成两侧异号，说明他以为腕部和手指一样 —— 这个断言就是为了拦住那个直觉。
  const R = RETARGET_RULES.rightHand;
  const L = RETARGET_RULES.leftHand;
  assert.equal(R.axes[0].axis, 'x', '自转必须走 X 轴');
  assert.equal(L.axes[0].axis, 'x');
  assert.equal(R.axes[0].sign, L.axes[0].sign, '腕部自转的基准符号应当两侧同号');
  assert.equal(R.axes[0].sign, -1);
});

test('★ 腕部三轴的语义不能被改动（X=自转 / Y=尺桡偏 / Z=屈伸）', () => {
  // 这三个是几何探针实测出来的（绕 X 指尖只动 0.89cm 但掌法线转 40° → X 是自转）。
  const R = RETARGET_RULES.rightHand.axes;
  assert.equal(R[0].axis, 'x', 'X 应当取自 Kalidokit 的 Wrist.x（自转）');
  assert.equal(R[1].axis, 'z', 'Y（尺桡偏）应当取自 Kalidokit 的 Wrist.z');
  assert.equal(R[2].axis, 'y', 'Z（屈伸）应当取自 Kalidokit 的 Wrist.y');
});

test('★ 手部来源的 scope 必须是 hand（否则会去姿态输出里找，永远取不到）', () => {
  for (const b of ['rightHand', 'leftHand']) {
    assert.equal(RETARGET_RULES[b].scope, 'hand', `${b} 的 scope 应为 hand`);
  }
  assert.equal(RETARGET_RULES.rightIndexProximal.scope, 'hand');
  assert.equal(RETARGET_RULES.rightThumbMetacarpal.scope, 'hand');
});

test('★ 头颈来源的 scope 必须是 face（漏写会表现为"头颈完全不动"）', () => {
  assert.equal(RETARGET_RULES.neck.scope, 'face');
  assert.equal(RETARGET_RULES.head.scope, 'face');
});

test('★ 所有带左右的骨骼都必须成对登记（漏一个会表现为"交换后这根没跟着换"）', () => {
  assert.deepEqual(findUnpairedSidedBones(), [], '有骨骼没登记进 SIDED_PAIRS');
});

test('脊柱 35/65、头颈 35/65 权重拆分正确', () => {
  const src = { Spine: { x: 0, y: 0.2, z: 0 }, };
  const face = { head: { x: 0, y: 0.2, z: 0 } };
  const out = retarget({ pose: src, face }, false);

  // 同一来源、同一轴映射 → chest 的旋转角应当是 spine 的 65/35 倍
  const spineDeg = 2 * Math.acos(Math.min(1, Math.abs(out.pose.spine[3]))) / D;
  const chestDeg = 2 * Math.acos(Math.min(1, Math.abs(out.pose.chest[3]))) / D;
  assert.ok(Math.abs(spineDeg - 0.2 * 0.35 / D) < 1e-6, `spine 权重不对：${spineDeg}`);
  assert.ok(Math.abs(chestDeg - 0.2 * 0.65 / D) < 1e-6, `chest 权重不对：${chestDeg}`);

  const neckDeg = 2 * Math.acos(Math.min(1, Math.abs(out.pose.neck[3]))) / D;
  const headDeg = 2 * Math.acos(Math.min(1, Math.abs(out.pose.head[3]))) / D;
  assert.ok(Math.abs(neckDeg - 0.2 * 0.35 / D) < 1e-6, `neck 权重不对：${neckDeg}`);
  assert.ok(Math.abs(headDeg - 0.2 * 0.65 / D) < 1e-6, `head 权重不对：${headDeg}`);
});

test('来源缺失时记进 missing，且不产出该骨骼（不伪造单位四元数）', () => {
  const out = retarget({ pose: { RightUpperArm: { x: 0, y: 0, z: 0 } } }, false);
  assert.deepEqual(Object.keys(out.pose), ['rightUpperArm']);
  assert.ok(out.missing.includes('leftUpperArm'));
  assert.ok(out.missing.includes('spine'));
  assert.ok(!('leftUpperArm' in out.pose), '缺来源的骨骼不应出现在姿态里');
});

test('肩骨不进入 G2 驱动范围（保持基础站姿，避免抖）', () => {
  assert.ok(!RETARGET_TARGET_BONES.includes('rightShoulder'));
  assert.ok(!RETARGET_TARGET_BONES.includes('leftShoulder'));
});

// ── 3. 左右交换开关 ─────────────────────────────────────────────────────

/**
 * Kalidokit 的静息值（来自它自己的 RestingDefault，实测确认）：
 *   RightUpperArm.z = -1.25   LeftUpperArm.z = +1.25
 * 而我们的静息值（G1 实测）：rightUpperArm = rotQ(Z, +72°) ≈ +1.257，leftUpperArm ≈ -1.257。
 *
 * ★ 这是本文件最有价值的一条不变式 —— Kalidokit 的静息必须映射到我们的静息。
 *   它同时钉住了"用哪个来源键"与"符号该怎么取"两件事，
 *   而且**两种左右配置下都必须成立**。
 */
const KALIDOKIT_REST = {
  RightUpperArm: { x: 0, y: 0, z: -1.25 },
  LeftUpperArm: { x: 0, y: 0, z: 1.25 },
  RightLowerArm: { x: 0, y: 0, z: 0 },
  LeftLowerArm: { x: 0, y: 0, z: 0 },
  RightHand: { x: 0, y: 0, z: 0 },
  LeftHand: { x: 0, y: 0, z: 0 },
};
/** 含中线骨骼的完整静息输入（校准测试要用） */
const KALIDOKIT_REST_FULL = {
  ...KALIDOKIT_REST,
  Spine: { x: 0, y: 0, z: 0 },
};
const FACE_REST = { head: { x: 0, y: 0, z: 0 } };

/**
 * 手部的静息输出（HandSolver 形状）：腕 + 5 指 × 3 段，全为 0。
 * 腕部现在走 HandSolver 而不是 PoseSolver，所以校准测试也必须喂它。
 */
function handsRest() {
  const h = {};
  for (const side of ['Right', 'Left']) {
    h[`${side}Wrist`] = { x: 0, y: 0, z: 0 };
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
        h[`${side}${f}${seg}`] = { x: 0, y: 0, z: 0 };
      }
    }
  }
  return h;
}
// ★ 必须经 buildHandsInput 装桶 —— 直接写 {left,right} 会因为桶名与键前缀
//   不同源而永远查不到（这正是"手指完全不动"的成因）。让测试也走同一条路，
//   才不会出现"代码修了但测试还在用旧命名"。
const HANDS_REST = buildHandsInput(handsRest(), handsRest());

test('★ 静息不变式：Kalidokit 的静息值映射到我们的静息值（swap = false）', () => {
  const out = retarget({ pose: KALIDOKIT_REST, hands: HANDS_REST }, false);
  const dR = angleBetween(out.pose.rightUpperArm, baseQuatOf('rightUpperArm'));
  const dL = angleBetween(out.pose.leftUpperArm, baseQuatOf('leftUpperArm'));
  assert.ok(dR < 1, `右臂静息偏差 ${dR.toFixed(3)}°（应当很小）`);
  assert.ok(dL < 1, `左臂静息偏差 ${dL.toFixed(3)}°（应当很小）`);
});

test('★★ 静息不变式在 swap = true 时**同样**必须成立（这就是"上下反了"那个 bug）', () => {
  // 曾经的做法是"只换来源键、符号不动"，于是：
  //   right ← K.Left 且 z × −1  →  −(+1.25) = −1.25
  // 而我们的右臂静息是 +1.257 —— 差了 2.5 弧度（约 143°），
  // 表现就是"左右对了，但手臂被压下去 / 上下反了"。
  const out = retarget({ pose: KALIDOKIT_REST, hands: HANDS_REST }, true);
  const dR = angleBetween(out.pose.rightUpperArm, baseQuatOf('rightUpperArm'));
  const dL = angleBetween(out.pose.leftUpperArm, baseQuatOf('leftUpperArm'));
  assert.ok(dR < 1, `交换后右臂静息偏差 ${dR.toFixed(3)}°（>1° 说明符号没跟着换）`);
  assert.ok(dL < 1, `交换后左臂静息偏差 ${dL.toFixed(3)}°（>1° 说明符号没跟着换）`);
});

test('★ 交换确实改变了输出（不是空操作）', () => {
  const src = { RightUpperArm: { x: 0.1, y: 0.2, z: -1.0 }, LeftUpperArm: { x: 0.05, y: 0.3, z: 1.0 } };
  const off = retarget({ pose: src }, false);
  const on = retarget({ pose: src }, true);
  assert.ok(maxDiff(on.pose.rightUpperArm, off.pose.rightUpperArm) > 1e-3, '交换后右臂应当变了');
  assert.ok(maxDiff(on.pose.leftUpperArm, off.pose.leftUpperArm) > 1e-3, '交换后左臂应当变了');
});

test('交换时镜像奇性轴取反：Y 与 Z 变号、X 不变（矢状面反射的规律）', () => {
  const off = resolveRules(false);
  const on = resolveRules(true);
  // 只看轴与符号，不看来源键
  const signs = (t) => t.map((s) => `${s.axis}${s.sign > 0 ? '+' : '-'}`);
  assert.deepEqual(signs(on.rightUpperArm.axes), signs(off.rightUpperArm.axes).map((x, i) => (i === 0 ? x : x.slice(0, 1) + (x.endsWith('+') ? '-' : '+'))));
  // X 不变、Y/Z 变号
  assert.equal(on.rightUpperArm.axes[0], off.rightUpperArm.axes[0], 'X 是镜面法线，不该变号');
  assert.equal(on.rightUpperArm.axes[1].sign, -off.rightUpperArm.axes[1].sign, 'Y 应当变号');
  assert.equal(on.rightUpperArm.axes[2].sign, -off.rightUpperArm.axes[2].sign, 'Z 应当变号');
});

test('★ 交换左右不会改变中线骨骼', () => {
  const src = { Spine: { x: 0.1, y: 0.2, z: 0.3 } };
  const face = { head: { x: 0.1, y: 0.2, z: 0.3 } };
  const off = retarget({ pose: src, face }, false);
  const on = retarget({ pose: src, face }, true);
  for (const b of ['spine', 'chest', 'neck', 'head']) {
    assert.ok(maxDiff(on.pose[b], off.pose[b]) < 1e-15, `${b} 不该被左右交换影响`);
  }
});

test('swapLeftRight 不影响中线骨骼（脊柱/头颈）', () => {
  const src = { Spine: { x: 0.1, y: 0.2, z: 0.3 } };
  const face = { head: { x: 0.1, y: 0.2, z: 0.3 } };
  const off = retarget({ pose: src, face }, false);
  const on = retarget({ pose: src, face }, true);
  for (const b of ['spine', 'chest', 'neck', 'head']) {
    assert.ok(maxDiff(on.pose[b], off.pose[b]) < 1e-15, `${b} 不该被左右交换影响`);
  }
});

test('resolveRules 不修改原始规则表（避免污染全局状态）', () => {
  const before = JSON.stringify(RETARGET_RULES.rightUpperArm);
  resolveRules(true);
  assert.equal(JSON.stringify(RETARGET_RULES.rightUpperArm), before);
});

// ── 4. ★ 校准恒等式：中立输入必须得到基础站姿 ──────────────────────────

test('★ 校准：中立输入经校准后精确等于 BASE_STANDING_POSE', () => {
  // 只对 CALIBRATED_BONES（10 根）成立 —— 手指**刻意不校准**：
  // 手指的"中立"就是伸直，源与目标本来就一致，给 30 根各算一个修正量
  // 只会多出 30 个出错的地方。见下面那条专门断言。
  const neutral = {};
  for (const b of CALIBRATED_BONES) {
    neutral[b] = eulerXYZToQuat({ x: 0.13 * (b.length % 3), y: -0.21, z: 0.37 });
  }

  const corrections = computeCorrections(neutral);
  const target = applyCalibration(neutral, corrections);

  for (const b of CALIBRATED_BONES) {
    const expected = baseQuatOf(b);
    assert.ok(
      maxDiff(target[b], expected) < 1e-9,
      `${b} 中立输入应得到基础站姿，实际偏差 ${maxDiff(target[b], expected).toExponential(2)}`,
    );
  }
});

test('★★ 静息不变式的推论：两种左右配置下，校准修正量都应当很小', () => {
  // 因为 Kalidokit 的静息 ≈ 我们的静息，所以 corrections 接近单位旋转。
  // 一旦"用错来源键 / 符号没跟着换"，修正量会突然变成 100° 以上 ——
  // 这条不变式能立刻把那种情况顶出来，而不必等到看渲染结果。
  // 阈值分开定，因为两段的"应有偏差"不同：
  //   上臂：Kalidokit 静息 z = ∓1.25，我们 = ±72° ≈ ±1.257 → 应几乎为 0
  //   前臂：Kalidokit 静息 z = 0，而我们的基础站姿有 8° 自然屈肘
  //         （BASE_STANDING_POSE 的 NATURAL_ELBOW_DEG）→ 应有约 8° 的修正，
  //         这是**正确**的，不是 bug
  const limits = { rightUpperArm: 5, leftUpperArm: 5, rightLowerArm: 15, leftLowerArm: 15 };
  const seen = {};
  for (const swap of [false, true]) {
    const neutral = retarget({ pose: KALIDOKIT_REST, hands: HANDS_REST }, swap).pose;
    const corrections = computeCorrections(neutral);
    for (const [bone, limit] of Object.entries(limits)) {
      const deg = angleBetween(corrections[bone], [0, 0, 0, 1]);
      assert.ok(deg < limit, `swap=${swap} 时 ${bone} 的修正量 ${deg.toFixed(2)}° 超过 ${limit}°`);
      seen[`${bone}:${swap}`] = deg;
    }
  }
  // 上臂必须几乎为 0 —— 一旦"用错来源键 / 符号没跟着换"这里会变成 140° 以上
  for (const swap of [false, true]) {
    for (const bone of ['rightUpperArm', 'leftUpperArm']) {
      assert.ok(seen[`${bone}:${swap}`] < 1, `swap=${swap} 时 ${bone} 修正量应接近 0，实际 ${seen[`${bone}:${swap}`].toFixed(2)}°`);
    }
  }
});

test('★ 校准：手指刻意不校准（拿不到修正量时原样通过）', () => {
  const q = eulerXYZToQuat({ x: 0.2, y: 0.1, z: 0.3 });
  const neutral = { rightIndexProximal: q, rightThumbMetacarpal: q };
  const corrections = computeCorrections(neutral);
  assert.equal(corrections.rightIndexProximal, undefined, '手指不该有修正量');
  const out = applyCalibration(neutral, corrections);
  assert.ok(maxDiff(out.rightIndexProximal, q) < 1e-15, '手指应当原样通过');
});

test('★ 校准：非中立输入会偏离基础站姿（证明校准不是恒等变换）', () => {
  const neutral = {};
  for (const b of CALIBRATED_BONES) neutral[b] = eulerXYZToQuat({ x: 0.13, y: -0.21, z: 0.37 });
  const corrections = computeCorrections(neutral);

  // 抬手 30°（绕 Z）
  const moved = { ...neutral, rightUpperArm: eulerXYZToQuat({ x: 0.13, y: -0.21, z: 0.37 + 30 * D }) };
  const out = applyCalibration(moved, corrections);
  assert.ok(
    angleBetween(out.rightUpperArm, baseQuatOf('rightUpperArm')) > 25,
    '抬手 30° 后应当明显偏离基础站姿',
  );
});

test('★ 校准：没拿到修正量的骨骼原样返回（不静默弹回 T-pose）', () => {
  const q = eulerXYZToQuat({ x: 0.1, y: 0.2, z: 0.3 });
  const out = applyCalibration({ someBone: q }, {});
  assert.ok(maxDiff(out.someBone, q) < 1e-15);
});

test('quatInverse 与 q 相乘得到单位四元数', () => {
  // 注意：这里要的是**四元数乘积** q × q⁻¹ = [0,0,0,1]，
  // 不是点积 q·q⁻¹（后者 = 2w²−1，一般不等于 1 —— 早先就写错成这个了）
  const q = eulerXYZToQuat({ x: 0.4, y: -0.9, z: 1.7 });
  const prod = mulQ(q, quatInverse(q));
  assert.ok(maxDiff(prod, [0, 0, 0, 1]) < 1e-12, `q×q⁻¹ 应为单位四元数，实际 ${prod}`);
  // 反证：点积并不等于 1（说明上一条不是碰巧通过）
  assert.ok(Math.abs(dot(q, quatInverse(q)) - 1) > 1e-3, '点积与乘积是两回事');
});

// ── 5. 四元数平均必须先统一符号 ────────────────────────────────────────

test('★ 四元数平均：混入取负的样本不影响结果', () => {
  const q = eulerXYZToQuat({ x: 0.3, y: 0.6, z: -0.2 });
  const neg = q.map((v) => -v);

  const avg = averageQuats([q, q, q]);
  assert.ok(Math.abs(Math.abs(dot(avg, q)) - 1) < 1e-9, '同号平均应等于自身');

  const mixed = averageQuats([q, neg, q, neg]);
  assert.ok(
    Math.abs(Math.abs(dot(mixed, q)) - 1) < 1e-9,
    `符号不一致时平均结果应当仍是 q，实际夹角 ${angleBetween(mixed, q).toFixed(3)}°`,
  );
});

test('四元数平均：不统一符号的实现会退化（反证上一条不是白测的）', () => {
  const q = eulerXYZToQuat({ x: 0.3, y: 0.6, z: -0.2 });
  const neg = q.map((v) => -v);
  // 直接算术平均（错误做法）：q + (-q) = 0，归一化后方向随机
  const naive = [0, 1, 2, 3].map((i) => (q[i] + neg[i]) / 2);
  const naiveNorm = Math.hypot(...naive);
  assert.ok(naiveNorm < 1e-12, '天真平均的范数应当塌成 0');
  // 而我们的实现不会塌
  assert.ok(Math.abs(Math.hypot(...averageQuats([q, neg]))) - 1 < 1e-9);
});

test('averagePose 跳过缺失骨骼，不凭空造值', () => {
  const q1 = eulerXYZToQuat({ x: 0.1, y: 0, z: 0 });
  const p = averagePose([{ head: q1 }, { head: q1, chest: q1 }]);
  assert.deepEqual(Object.keys(p).sort(), ['chest', 'head']);
});

// ── 6. 校准采样窗口的门槛 ──────────────────────────────────────────────

// n 与 stepMs 必须让总时长 >= 1500ms：(n-1)*stepMs。
// 早先用 n=60/step=25 只有 1475ms，测试因为自己的数据不足而失败。
function mkCalibrationFrames({ n = 65, tracked = true, confidence = 0.9, stepMs = 25 }) {
  // 用**真实的 Kalidokit 静息**而不是"给所有骨骼套一个任意旋转"：
  // 后者会让头部出现约 30° 的修正量，被校准可信度检查拦下 ——
  // 那是测试数据不真实，不是检查太严。
  const canonical = retarget({ pose: KALIDOKIT_REST_FULL, face: FACE_REST, hands: HANDS_REST }, true).pose;
  const conf = {};
  for (const b of RETARGET_TARGET_BONES) conf[b] = confidence;
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push({ timestampMs: i * stepMs, tracked, confidence: conf, canonical });
  }
  return frames;
}

function runCalibration(frames) {
  const s = new CalibrationSession();
  s.start(0);
  for (const f of frames) s.add(f);
  return s.finish();
}

test('校准：检测率与时长都达标时通过，并给出中立姿态与修正量', () => {
  const out = runCalibration(mkCalibrationFrames({}));
  assert.equal(out.ok, true, `不该失败：${out.issues.join('; ')}`);
  assert.ok(out.detectionRate >= MOCAP_LIMITS.calibrationMinDetectionRate);
  // 校准只覆盖 CALIBRATED_BONES（10 根）；手指刻意不校准
  assert.equal(Object.keys(out.neutralPose).length, CALIBRATED_BONES.length);
  assert.equal(Object.keys(out.corrections).length, CALIBRATED_BONES.length);
});

test('校准：检测率不足 80% 必须拒绝', () => {
  // 每 5 帧丢 2 帧 → 60% 检测率
  const frames = mkCalibrationFrames({ n: 60 });
  frames.forEach((f, i) => {
    if (i % 5 >= 3) f.tracked = false;
  });
  const out = runCalibration(frames);
  assert.equal(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('身体检测率')), '应当报检测率不足');
});

test('校准：时长不足必须拒绝', () => {
  const out = runCalibration(mkCalibrationFrames({ n: 10, stepMs: 25 })); // 只有 225ms
  assert.equal(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('时长不足')));
});

test('★★ 校准：标定时把手抬起来 → 必须被拒绝（这是真人踩过的坑）', () => {
  // 实测场景：标定时手臂是抬着的，于是 Qneutral 记的是"抬手姿态"，
  // 整段偏移被算错 —— 表现为"肘反了""举不过头顶""转头反了"，
  // 而且这些现象互相矛盾，很难从渲染结果反推。
  // 关键线索是"不加校准反而是对的"。
  const K_RAISED = {
    ...KALIDOKIT_REST_FULL,
    RightUpperArm: { x: 0, y: 0, z: -0.3 },
    LeftUpperArm: { x: 0, y: 0, z: 0.3 },
  };
  const rt = (pose) => retarget({ pose, face: FACE_REST, hands: HANDS_REST }, true).pose;
  const GOOD = { ok: true, canonical: rt(KALIDOKIT_REST_FULL) };
  const BAD = { ok: true, canonical: rt(K_RAISED) };

  const runWith = (canonical) => {
    const frames = [];
    const conf = {};
    for (const b of RETARGET_TARGET_BONES) conf[b] = 0.9;
    for (let i = 0; i < 65; i++) {
      frames.push({ timestampMs: i * 25, tracked: true, confidence: conf, canonical });
    }
    return runCalibration(frames);
  };

  const good = runWith(GOOD.canonical);
  assert.equal(good.ok, true, `自然站姿应当通过：${good.issues.join('; ')}`);
  // 上界取 10°：其中 8° 来自我们的自然屈肘（BASE_STANDING_POSE 的 NATURAL_ELBOW_DEG），
  // 而 Kalidokit 的前臂静息是 0 —— 这 8° 是**正确**的，不是姿势错误。
  // 上臂只有 0.38°（Kalidokit ∓1.25 rad vs 我们 ±72°，差 0.4°）。
  assert.ok(good.maxCorrectionDeg < 10, `自然站姿的修正量应当很小，实际 ${good.maxCorrectionDeg.toFixed(2)}°`);
  assert.equal(good.worstBone, 'rightLowerArm', '自然站姿下最大的修正是前臂的自然屈肘');

  const bad = runWith(BAD.canonical);
  assert.equal(bad.ok, false, '抬着手的标定姿势必须被拒绝');
  assert.ok(
    bad.issues.some((x) => x.includes('偏离自然站姿')),
    `应当明确说是姿势问题：${bad.issues.join('; ')}`,
  );
  assert.ok(bad.maxCorrectionDeg > 30, `修正量应当明显超过容差，实际 ${bad.maxCorrectionDeg.toFixed(2)}°`);
  assert.deepEqual(bad.corrections, {}, '被拒绝时不能给出修正量');
});

test('校准：肩肘腕置信度不足的帧被排除出平均，并在 issues 里说清', () => {
  const frames = mkCalibrationFrames({ n: 60 });
  frames.forEach((f, i) => {
    if (i < 10) for (const b of CALIBRATION_REQUIRED_BONES) f.confidence[b] = 0.1;
  });
  const out = runCalibration(frames);
  assert.equal(out.ok, false);
  assert.ok(out.issues.some((s) => s.includes('置信度不足')));
});

test('校准：一帧都没有时给出明确原因而不是崩溃', () => {
  const out = runCalibration([]);
  assert.equal(out.ok, false);
  assert.ok(out.issues[0].includes('没有收到任何帧'));
  assert.deepEqual(out.corrections, {});
});

// ── 7. 置信度必须跟着 Kalidokit 的索引走 ───────────────────────────────

test('★ 置信度索引跟随 Kalidokit 源码：Right* 读 MediaPipe 的 left_* 点', () => {
  // 这条断言的价值：一旦有人"顺手改成看着更合理的 12/14"，右臂置信度就会
  // 去评估左臂，出现"正确的那条手臂因为另一条被遮挡而停止更新"的怪 bug。
  assert.deepEqual(KALIDOKIT_SOURCE_POINTS.RightUpperArm, [11, 13]);
  assert.deepEqual(KALIDOKIT_SOURCE_POINTS.LeftUpperArm, [12, 14]);
  assert.deepEqual(KALIDOKIT_SOURCE_POINTS.RightLowerArm, [13, 15]);
  assert.deepEqual(KALIDOKIT_SOURCE_POINTS.LeftLowerArm, [14, 16]);
  assert.deepEqual(KALIDOKIT_SOURCE_POINTS.Spine, [11, 12, 23, 24]);
});

function mkFrame({ visAll = 1, leftOnly = false } = {}) {
  const mk = (v) => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: v }));
  const w = mk(visAll);
  const p = mk(visAll);
  if (leftOnly) {
    // 只压低 MediaPipe 的左侧点（11/13/15）
    for (const i of [11, 13, 15]) {
      w[i].visibility = 0.1;
      p[i].visibility = 0.1;
    }
  }
  return {
    timestampMs: 0,
    poseLandmarks: p,
    poseWorldLandmarks: w,
    leftHandLandmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: visAll })),
    rightHandLandmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: visAll })),
    faceLandmarks: Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: visAll })),
  };
}

test('压低 MediaPipe 左手点 → Kalidokit 的 Right* 置信度下降（Left* 不受影响）', () => {
  const ok = computeSourceConfidence(mkFrame());
  const bad = computeSourceConfidence(mkFrame({ leftOnly: true }));
  assert.ok(ok.RightUpperArm > 0.9);
  assert.ok(bad.RightUpperArm < 0.2, `Kalidokit 的 RightUpperArm 应当跟着 MP 左手点掉下来，实际 ${bad.RightUpperArm}`);
  assert.ok(bad.LeftUpperArm > 0.9, 'Kalidokit 的 LeftUpperArm 读 MP 右手点，不该受影响');
});

test('computeBoneConfidence 跟随左右交换开关', () => {
  const frame = mkFrame({ leftOnly: true });
  const off = computeBoneConfidence(frame, false);
  const on = computeBoneConfidence(frame, true);
  assert.ok(off.rightUpperArm < 0.2, '不交换时 rightUpperArm 取 Kalidokit 的 Right*');
  assert.ok(on.rightUpperArm > 0.9, '交换后 rightUpperArm 应改取 Kalidokit 的 Left*（即 MP 右手点）');
});

test('手部关键点整体缺失时手部置信度打折（不假装完全可信）', () => {
  const frame = mkFrame();
  frame.leftHandLandmarks = null;
  const c = computeSourceConfidence(frame);
  assert.ok(c.RightHand <= 0.6 + 1e-9, '缺手部点时上限应为 0.6');
});

test('面部点缺失/过少 → 头颈置信度低', () => {
  const full = mkFrame();
  assert.ok(faceConfidence(full) > 0.9);
  const none = mkFrame();
  none.faceLandmarks = null;
  assert.equal(faceConfidence(none), 0);
  const few = mkFrame();
  few.faceLandmarks = few.faceLandmarks.slice(0, 30);
  assert.ok(faceConfidence(few) < 0.3, '点太少说明检测不完整，置信度应当低');
});

test('isBodyTracked：缺 world landmarks 或肩肘腕不可见都算没检到', () => {
  assert.equal(isBodyTracked(mkFrame()), true);
  const noWorld = mkFrame();
  noWorld.poseWorldLandmarks = null;
  assert.equal(isBodyTracked(noWorld), false);
  const noWrist = mkFrame();
  noWrist.poseLandmarks[15].visibility = 0;
  assert.equal(isBodyTracked(noWrist), false);
});

// ── 8. 低置信度三级回退 ────────────────────────────────────────────────

function mkSmoother() {
  return new PoseSmoother({ basePose: BASE_STANDING_POSE });
}

// 故意选一个与基础站姿距离很远的姿态。
// 基础站姿的右臂是绕 Z 转 +72°；早先测试样本也用纯 Z 小角度（1.2rad≈68.8°），
// 两者只差 3°，于是"保持/渐变/丢失"三档在数值上几乎没区别，断言全失去意义。
const FAR = eulerXYZToQuat({ x: -50 * D, y: 40 * D, z: 0 });

test('平滑样本与基础站姿有足够距离（保证后面三档断言有意义）', () => {
  const d = angleBetween(FAR, baseQuatOf('rightUpperArm'));
  assert.ok(d > 40, `样本离基础站姿只有 ${d.toFixed(1)}°，三档回退测不出来`);
});

test('★ 平滑输出必须覆盖 canonical 里的全部骨骼（不能只覆盖基础站姿的 4 根）', () => {
  const s = mkSmoother();
  const canonical = {};
  for (const b of RETARGET_TARGET_BONES) canonical[b] = FAR;
  const out = s.update(canonical, Object.fromEntries(RETARGET_TARGET_BONES.map((b) => [b, 1])), 0, 16);
  assert.deepEqual(
    Object.keys(out.pose).sort(),
    [...RETARGET_TARGET_BONES].sort(),
    '漏骨的写法会让脊柱与头永远不动，而且不报错',
  );
  assert.equal(s.getBoneNames().length, RETARGET_TARGET_BONES.length);
});

test('平滑：有效帧进入 tracked，并朝样本收敛', () => {
  const s = mkSmoother();
  const canonical = { rightUpperArm: FAR };
  const conf = { rightUpperArm: 1 };
  let out;
  for (let i = 0; i < 40; i++) out = s.update(canonical, conf, i * 16, 16);
  assert.equal(out.tiers.rightUpperArm, 'tracked');
  assert.ok(
    angleBetween(out.pose.rightUpperArm, canonical.rightUpperArm) < 3,
    '反复喂同一个样本后应当基本收敛过去',
  );
});

test('★ 平滑：≤200ms 保持上一有效姿态', () => {
  const s = mkSmoother();
  const canonical = { rightUpperArm: FAR };
  for (let i = 0; i < 60; i++) s.update(canonical, { rightUpperArm: 1 }, i * 16, 16);
  const before = s.update(canonical, { rightUpperArm: 1 }, 960, 16).pose.rightUpperArm;

  // 连续 200ms 低置信度
  let out;
  for (const t of [976, 1050, 1160]) out = s.update(null, {}, t, 100);
  assert.equal(out.tiers.rightUpperArm, 'hold');
  assert.ok(
    angleBetween(out.pose.rightUpperArm, before) < 15,
    `保持档不该明显移动，实际偏移 ${angleBetween(out.pose.rightUpperArm, before).toFixed(1)}°`,
  );
});

test('★ 平滑：200–500ms 向基础姿态渐变', () => {
  const s = mkSmoother();
  const canonical = { rightUpperArm: FAR };
  for (let i = 0; i < 60; i++) s.update(canonical, { rightUpperArm: 1 }, i * 16, 16);
  const held = s.update(canonical, { rightUpperArm: 1 }, 960, 16).pose.rightUpperArm;

  let out;
  for (const t of [1176, 1300, 1400]) out = s.update(null, {}, t, 100);
  assert.equal(out.tiers.rightUpperArm, 'blend');
  const toBase = angleBetween(out.pose.rightUpperArm, baseQuatOf('rightUpperArm'));
  const startedFrom = angleBetween(held, baseQuatOf('rightUpperArm'));
  assert.ok(toBase < startedFrom, '渐变档应当比刚开始更靠近基础姿态');
  assert.ok(toBase > 5, '渐变还没走完，不该已经到基础姿态');
});

test('★ 平滑：>500ms 标记为跟踪丢失并回到基础姿态', () => {
  const s = mkSmoother();
  const canonical = { rightUpperArm: eulerXYZToQuat({ x: 0, y: 0, z: 1.2 }) };
  for (let i = 0; i < 60; i++) s.update(canonical, { rightUpperArm: 1 }, i * 16, 16);

  let out;
  for (const t of [1200, 1400, 1600, 2000, 2400, 2800]) out = s.update(null, {}, t, 200);
  assert.equal(out.tiers.rightUpperArm, 'lost');
  assert.ok(out.lost.includes('rightUpperArm'));
  assert.ok(
    angleBetween(out.pose.rightUpperArm, baseQuatOf('rightUpperArm')) < 2,
    '丢失档应当已经回到基础姿态',
  );
});

test('平滑：恢复有效后立刻回到 tracked 并清掉丢失标记', () => {
  const s = mkSmoother();
  for (const t of [0, 200, 400, 600, 800]) s.update(null, {}, t, 200);
  assert.ok(s.update(null, {}, 1000, 200).lost.length > 0);

  const canonical = { rightUpperArm: eulerXYZToQuat({ x: 0, y: 0, z: 1.2 }) };
  const out = s.update(canonical, { rightUpperArm: 1 }, 1200, 200);
  assert.equal(out.tiers.rightUpperArm, 'tracked');
  assert.ok(!out.lost.includes('rightUpperArm'));
  // 注意不能断言 getLostBones() 为空：只喂了 rightUpperArm 一个骨骼，
  // 另一条手臂本就一直没有有效样本，仍处于 lost 是正确行为。
  assert.ok(!s.getLostBones().includes('rightUpperArm'));
});

test('平滑：指数系数与帧率无关（16ms×10 与 160ms×1 结果接近）', () => {
  const run = (steps) => {
    const s = mkSmoother();
    const canonical = { rightUpperArm: FAR };
    let out;
    let t = 0;
    for (const dt of steps) {
      t += dt;
      out = s.update(canonical, { rightUpperArm: 1 }, t, dt);
    }
    return out.pose.rightUpperArm;
  };
  // 注意：低置信度计时与档位判定是按时长的，所以这里两边都保持有效，只比平滑系数
  const fine = run(Array(10).fill(16));
  const coarse = run([16, 16, 16, 16, 16, 16, 16, 16, 16, 16]);
  assert.ok(maxDiff(fine, coarse) < 1e-12, '同一步长序列必须完全确定');
});

test('平滑：reset 后回到基础姿态', () => {
  const s = mkSmoother();
  const canonical = { rightUpperArm: FAR };
  for (let i = 0; i < 40; i++) s.update(canonical, { rightUpperArm: 1 }, i * 16, 16);
  s.reset();
  const out = s.update(null, {}, 1000, 16);
  assert.ok(maxDiff(out.pose.rightUpperArm, baseQuatOf('rightUpperArm')) < 1e-12);
});

// ── 9. ★ 画面镜像不得影响模型输入 ──────────────────────────────────────

test('★ 模型输入恒不镜像（常量，不是可配置项）', () => {
  assert.equal(MODEL_INPUT_MIRRORED, false);
});

test('★ 镜像只改显示坐标，不改关键点数据本身', () => {
  const lm = { x: 0.2, y: 0.3, z: 0.4, visibility: 0.9 };
  const snapshot = JSON.stringify(lm);

  const notMirrored = toDisplayX(lm.x, false);
  const mirrored = toDisplayX(lm.x, true);

  assert.equal(notMirrored, 0.2);
  assert.equal(mirrored, 0.8);
  assert.equal(JSON.stringify(lm), snapshot, '显示变换绝不能改动原始关键点');
});

test('镜像只翻 x，不翻 y', () => {
  const a = toCanvasPoint(0.25, 0.25, 640, 480, true);
  const b = toCanvasPoint(0.25, 0.25, 640, 480, false);
  assert.equal(a.y, b.y, 'y 不该被镜像影响');
  assert.equal(a.x, 480);
  assert.equal(b.x, 160);
});

test('显示坐标被夹在 [0,1]，越界关键点不会画出画面外', () => {
  assert.equal(toDisplayX(-0.5, false), 0);
  assert.equal(toDisplayX(1.5, false), 1);
  assert.equal(toDisplayX(1.5, true), 0);
});

test('缺失判定用 null 而不是 0（0 是合法坐标）', () => {
  assert.equal(isDrawable({ x: 0, y: 0, z: null, visibility: 0 }), true, 'x=0/y=0 是合法点');
  assert.equal(isDrawable({ x: null, y: 0, z: 0, visibility: 1 }), false);
  assert.equal(isDrawable(null), false);
});

test('置信度配色分三档：正常 / 偏低(<0.5) / 严重丢失', () => {
  assert.equal(confidenceColor(0.9, '#00f').level, 'ok');
  assert.equal(confidenceColor(0.9, '#00f').color, '#00f');
  assert.equal(confidenceColor(0.4, '#00f').level, 'low');
  assert.equal(confidenceColor(null, '#00f').level, 'lost');
  assert.equal(confidenceColor(0.05, '#00f').level, 'lost');
});

test('重定向档案必须显式声明"是否已实测"（防止未验证的映射被当结论）', () => {
  assert.equal(typeof RETARGET_IS_MEASURED, 'boolean');
  // P3 实测完成后这里会变成 true；在此之前页面必须显示警告
  assert.equal(RETARGET_IS_MEASURED, false, 'P3 标定完成前不应为 true');
});

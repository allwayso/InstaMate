/**
 * 麦克风失败的分类与解释。
 *
 * 为什么值得单独测：这段逻辑的价值**全在"给用户看什么"**，
 * 而它上一次的样子是直接把 DOMException 的 message 抛给用户：
 *
 *     NotFoundError: Requested device not found
 *
 * 用户既不知道为什么，也不知道下一步做什么。所以这里的断言不只是"分类对不对"，
 * 更是"说清原因了吗 / 给出动作了吗"——后者才是这次修改的目的。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioInputLabels, classifyMicFailure, collectAudioInputLabels, describeMicFailure,
} from '../web/lib/mic-diagnostics.ts';

/** 造一个像 DOMException 的东西 */
const domError = (name, message = '') => Object.assign(new Error(message), { name });

test('★ 把 DOMException 归类成有限的几种失败', () => {
  assert.equal(classifyMicFailure(domError('NotFoundError')), 'no-device');
  assert.equal(classifyMicFailure(domError('NotAllowedError')), 'denied');
  assert.equal(classifyMicFailure(domError('NotReadableError')), 'busy');
  assert.equal(classifyMicFailure(domError('OverconstrainedError')), 'constraints');
  assert.equal(classifyMicFailure(domError('SecurityError')), 'insecure');
  // 旧浏览器用的别名
  assert.equal(classifyMicFailure(domError('DevicesNotFoundError')), 'no-device');
  assert.equal(classifyMicFailure(domError('TrackStartError')), 'busy');
  assert.equal(classifyMicFailure(domError('PermissionDeniedError')), 'denied');
  // 不像错误的东西不该炸，而是落到 unknown
  assert.equal(classifyMicFailure(null), 'unknown');
  assert.equal(classifyMicFailure('boom'), 'unknown');
  assert.equal(classifyMicFailure(new Error('x')), 'unknown');
});

test('★ no-device 要把「哪几个设备存在但不可用」列出来', () => {
  // 真实场景：Windows 设备管理器里 "外部麦克风 (Realtek)" 和
  // "麦克风 (Insta360 Ace Pro 2)" 都登记着，但状态是「未插入」——
  // 用户看到「找不到麦克风」的第一反应是「我明明插着」，
  // 列出设备名才能把问题定位到系统侧。
  const text = describeMicFailure('no-device', {
    labels: ['外部麦克风 (Realtek(R) Audio)', '麦克风 (Insta360 Ace Pro 2)'],
  });
  assert.match(text, /没有检测到可用的麦克风/);
  assert.match(text, /系统里登记了 2 个录音设备/);
  assert.match(text, /外部麦克风 \(Realtek\(R\) Audio\)/);
  assert.match(text, /Insta360 Ace Pro 2/);
  assert.match(text, /未就绪|不可用/);
});

test('no-device 在完全没有设备时，不要写"登记了 0 个"这种废话', () => {
  const text = describeMicFailure('no-device', { labels: [] });
  assert.match(text, /没有检测到可用的麦克风/);
  assert.doesNotMatch(text, /登记了 0 个/);
  assert.doesNotMatch(text, /系统里登记了/);
});

test('★ 每种失败都要给出「下一步做什么」，不能只说"请重试"', () => {
  const cases = {
    unsupported: /换新版 Chrome/,
    insecure: /localhost/,
    denied: /允许/,
    'no-device': /插入或启用/,
    busy: /关掉那些程序/,
    constraints: /采样率|声道/,
  };
  for (const [failure, expect] of Object.entries(cases)) {
    const text = describeMicFailure(failure);
    assert.match(text, expect, `${failure} 没有给出可操作的下一步：${text}`);
    // 中文解释，不是把英文原样端出来
    assert.doesNotMatch(text, /Requested device not found/);
  }
});

test('denied / busy 要能带上原始信息，但中文解释不能被挤掉', () => {
  const text = describeMicFailure('denied', { detail: 'Permission dismissed' });
  assert.match(text, /权限被拒绝/);
  assert.match(text, /Permission dismissed/);
});

test('constraints 把具体那条约束写出来', () => {
  assert.match(
    describeMicFailure('constraints', { constraint: 'sampleRate' }),
    /sampleRate/,
  );
});

test('audioInputLabels 只取音频输入，且丢掉空 label', () => {
  const devices = [
    { kind: 'audioinput', label: '外部麦克风' },
    { kind: 'videoinput', label: 'Insta360 Ace Pro 2' },
    { kind: 'audioinput', label: '   ' },
    { kind: 'audioinput', label: '麦克风 (USB)' },
    { kind: 'audiooutput', label: '扬声器' },
  ];
  // 注意：授权前 label 是空字符串（浏览器隐私要求），所以空 label 必须丢掉，
  // 否则会渲染出一串没有名字的点
  assert.deepEqual(audioInputLabels(devices), ['外部麦克风', '麦克风 (USB)']);
});

test('★ 枚举失败不能掩盖原始错误', async () => {
  // 权限被拒时 enumerateDevices 本身也可能抛，此时应当返回空列表，
  // 让调用方继续报「权限被拒」而不是变成一个空指针异常
  const labels = await collectAudioInputLabels(async () => {
    throw domError('NotAllowedError');
  });
  assert.deepEqual(labels, []);

  const ok = await collectAudioInputLabels(async () => [
    { kind: 'audioinput', label: '内置麦克风' },
  ]);
  assert.deepEqual(ok, ['内置麦克风']);
});

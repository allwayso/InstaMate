import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVendorFiles, REQUIRED_VENDOR_FILES } from '../web/lib/mocap/mediapipe-assets.ts';
import { stateAfterCameraStatus } from '../web/lib/mocap/capture-state.ts';
import { describeCameraError } from '../web/lib/mocap/camera-errors.ts';
import { HolisticSession } from '../web/lib/mocap/holistic-session.ts';

test('asset preflight reports missing requests and recovers on the next check', async () => {
  let repaired = false;
  const request = async (url, options) => {
    assert.equal(options.method, 'HEAD');
    assert.equal(options.cache, 'no-store');
    return { ok: repaired || !url.endsWith(REQUIRED_VENDOR_FILES[0]) };
  };
  assert.deepEqual(await checkVendorFiles(request), {
    ok: false, missing: [REQUIRED_VENDOR_FILES[0]], checked: 10,
  });
  repaired = true;
  assert.deepEqual(await checkVendorFiles(request), { ok: true, missing: [], checked: 10 });
});

test('unreachable resources are reported without rejecting preflight', async () => {
  const result = await checkVendorFiles(async () => { throw new Error('offline'); });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, REQUIRED_VENDOR_FILES);
});

test('retry after a camera failure returns to the recordable state', () => {
  const loading = stateAfterCameraStatus('error', 'starting', true);
  assert.equal(loading, 'loading-model');
  assert.equal(stateAfterCameraStatus(loading, 'running', true), 'ready');
  assert.equal(stateAfterCameraStatus(loading, 'running', false), 'detecting');
});

test('camera updates preserve active recording and stop releases the workflow', () => {
  assert.equal(stateAfterCameraStatus('recording', 'running', true), 'recording');
  assert.equal(stateAfterCameraStatus('ready', 'stopped', true), 'camera-off');
});

test('permission, device and busy errors give distinct recovery guidance', () => {
  assert.match(describeCameraError({ name: 'NotAllowedError' }), /权限/);
  assert.match(describeCameraError({ name: 'NotFoundError' }), /连接设备/);
  assert.match(describeCameraError({ name: 'NotReadableError' }), /占用/);
  assert.match(describeCameraError({ name: 'OverconstrainedError' }), /默认设备/);
  assert.equal(describeCameraError(new Error('模型初始化失败')), '模型初始化失败');
});

test('closing while permission is pending releases a subsequently granted camera', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalFetch = globalThis.fetch;
  let grant;
  let permissionRequested;
  const requested = new Promise(resolve => { permissionRequested = resolve; });
  let stops = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: () => {
      permissionRequested();
      return new Promise(resolve => { grant = resolve; });
    } },
  } });
  globalThis.fetch = async () => ({ ok: true });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  });
  const video = { srcObject: null };
  const session = new HolisticSession({ video, onFrame() {} });
  const start = session.start();
  await requested;
  session.stop();
  grant(stream);
  await start;
  assert.equal(stops, 1);
  assert.equal(video.srcObject, null);
  assert.equal(session.currentStatus, 'stopped');
  assert.equal(session.activeTrackCount, 0);
});

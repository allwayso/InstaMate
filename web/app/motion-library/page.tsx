'use client';

// ⚠️ 临时探针页 —— 用来验证 P0 的两条最高风险假设（F5）：
//   1) kalidokit 的 main 是「ESM + 无扩展名目录导入」，打包器能不能解析？
//   2) @mediapipe/holistic 的动态导入能不能过构建，运行时能不能起来？
// 验证完会被真正的 motion-library 页面替换。
import { useEffect, useState } from 'react';
import * as Kalidokit from 'kalidokit';

const VENDOR = '/vendor/mediapipe/holistic';
const REQUIRED = [
  'holistic.binarypb',
  'holistic_solution_packed_assets_loader.js',
  'holistic_solution_simd_wasm_bin.js',
  'holistic_solution_wasm_bin.js',
  'pose_landmark_lite.tflite',
  'pose_landmark_full.tflite',
  'holistic_solution_packed_assets.data',
  'holistic_solution_simd_wasm_bin.wasm',
  'holistic_solution_simd_wasm_bin.data',
  'holistic_solution_wasm_bin.wasm',
];

interface Line {
  label: string;
  ok: boolean;
  detail: string;
}

export default function MotionLibraryProbe() {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const push = (label: string, ok: boolean, detail: string) => {
      if (!cancelled) setLines((prev) => [...prev, { label, ok, detail }]);
    };

    (async () => {
      // ── 1. kalidokit 静态导入（模块级 import 已经过打包器，这里只验运行时形状）
      try {
        const keys = Object.keys(Kalidokit).sort().join(', ');
        push('kalidokit 导入', keys.includes('Pose') && keys.includes('Face'), keys);
      } catch (e) {
        push('kalidokit 导入', false, String(e));
      }

      // ── 2. kalidokit 真跑一次（用世界坐标，否则会被离屏守卫打回 RestingDefault）
      try {
        const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
        const set = (i: number, x: number, y: number, z = 0) => {
          lm[i] = { x, y, z, visibility: 1 };
        };
        set(11, 0.18, -0.5); set(12, -0.18, -0.5);
        set(13, 0.21, -0.25); set(14, -0.21, -0.25);
        set(15, 0.22, -0.03); set(16, -0.22, -0.03);
        set(17, 0.22, -0.03); set(19, 0.22, -0.03);
        set(18, -0.22, -0.03); set(20, -0.22, -0.03);
        set(23, 0.1, 0); set(24, -0.1, 0);
        const pose = Kalidokit.Pose.solve(lm, lm, {
          runtime: 'mediapipe',
          imageSize: { width: 640, height: 480 },
          enableLegs: false,
        });
        const rua = pose?.RightUpperArm;
        const isResting = rua && Math.abs(rua.z + 1.25) < 1e-9;
        push(
          'Pose.solve 实跑',
          !!pose && !!rua,
          pose ? `RightUpperArm.z=${rua?.z?.toFixed(4)}${isResting ? '（= RestingDefault −1.25，说明被离屏守卫拦了）' : ''}` : 'undefined',
        );
      } catch (e) {
        push('Pose.solve 实跑', false, String(e));
      }

      // ── 3. vendor 文件是否真的可访问（步骤 7 的自检雏形）
      try {
        const results = await Promise.all(
          REQUIRED.map(async (f) => {
            try {
              const res = await fetch(`${VENDOR}/${f}`, { method: 'HEAD' });
              return { f, ok: res.ok, status: res.status };
            } catch {
              return { f, ok: false, status: -1 };
            }
          }),
        );
        const bad = results.filter((r) => !r.ok);
        push(
          'vendor 文件可访问',
          bad.length === 0,
          bad.length === 0
            ? `${results.length}/${results.length} 全部可达`
            : `缺 ${bad.map((b) => `${b.f}(${b.status})`).join(', ')}`,
        );
      } catch (e) {
        push('vendor 文件可访问', false, String(e));
      }

      // ── 4. @mediapipe/holistic 动态导入 + 实例化（不需要摄像头）
      try {
        const mod = await import('@mediapipe/holistic');
        const Holistic = (mod as { Holistic?: unknown }).Holistic;
        push('holistic 动态导入', typeof Holistic === 'function', typeof Holistic === 'function' ? 'Holistic 是构造函数' : `导出: ${Object.keys(mod).join(', ')}`);
        if (typeof Holistic === 'function') {
          const instance = new (Holistic as new (o: unknown) => { setOptions: (o: unknown) => void; close?: () => void })({
            locateFile: (file: string) => `${VENDOR}/${file}`,
          });
          instance.setOptions({
            selfieMode: false,
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            refineFaceLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          push('holistic 实例化', true, 'setOptions 成功');
          if (typeof instance.close === 'function') instance.close();
        }
      } catch (e) {
        push('holistic 动态导入', false, String(e));
      }

      if (!cancelled) setBusy(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const allOk = !busy && lines.length > 0 && lines.every((l) => l.ok);

  return (
    <main style={{ padding: 24, fontFamily: 'ui-monospace, monospace', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 18 }}>G2 P0 探针</h1>
      <p style={{ color: busy ? '#888' : allOk ? '#2f9e44' : '#e03131' }}>
        {busy ? '检测中…' : allOk ? '全部通过' : '存在失败项'}
      </p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ color: l.ok ? '#2f9e44' : '#e03131' }}>
            {l.ok ? '✓' : '✗'} {l.label} — <span style={{ color: '#666' }}>{l.detail}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

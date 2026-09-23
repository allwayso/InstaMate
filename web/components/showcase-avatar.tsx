'use client';

import { useEffect, useRef, useState } from 'react';
import { VrmScene } from '@/lib/vrm-scene';
import styles from '@/app/showcase/showcase.module.css';

const AVATAR_URL = '/avatars/compat.vrm';
const TURN_DURATION_MS = 18_000;

export default function ShowcaseAvatar() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let scene: VrmScene;

    try {
      scene = new VrmScene(mount, { background: 0x142026, controls: false });
    } catch {
      setStatus('error');
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const frameAvatar = () => {
      scene.resize();
      if (scene.getSlots().length === 0) return;
      scene.frameCamera();
    };
    const resizeObserver = new ResizeObserver(() => {
      frameAvatar();
    });
    resizeObserver.observe(mount);

    void scene
      .loadSlot('showcase', AVATAR_URL)
      .then((slot) => {
        if (disposed) return;

        slot.runtime.applyBasePose();
        slot.runtime.commit(0);
        frameAvatar();

        const startTime = performance.now();
        scene.start((delta) => {
          // 用绝对时间计算角度，帧率变化时也保持恒定转速。
          slot.root.rotation.y = reducedMotion.matches
            ? 0
            : ((performance.now() - startTime) / TURN_DURATION_MS) * Math.PI * 2;
          slot.runtime.commit(delta);
        });
        setStatus('ready');
      })
      .catch(() => {
        if (!disposed) setStatus('error');
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      scene.dispose();
    };
  }, []);

  return (
    <div className={styles.avatarStage}>
      <div
        ref={mountRef}
        className={styles.avatarCanvas}
        role="img"
        aria-label="缓慢匀速旋转的 3D 数字人"
      />
      {status !== 'ready' && (
        <p className={styles.avatarStatus} role="status">
          {status === 'loading' ? '正在唤醒数字人…' : '数字人暂时无法显示，请检查 VRM 资源。'}
        </p>
      )}
    </div>
  );
}

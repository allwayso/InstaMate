'use client';

/**
 * VRM 预览：实时动作 / 录后回放 / 单角色 / 双角色。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  双角色是怎么做的（这是 G2 的门槛）
 * ══════════════════════════════════════════════════════════════════════════
 *  · **同一个 scene 与 renderer**，两个角色左右并排
 *  · 每个角色有**自己的 CharacterRuntime**（各自缓存骨骼引用、各自 commit）
 *  · **共用同一份采样结果**：ClipPlayer 只推进一次，返回一个 Pose，
 *    然后分别写进两个 runtime，再各自 vrm.update 一次
 *  · **不复制、不重算、不针对角色改 clip** —— 所以两个角色骨长/比例不同也能同播，
 *    这同时验证了 G1「clip 只存旋转、不存骨长与位移」这个设计决定
 *
 *  每帧顺序固定（与 G1 一致）：
 *    播放器推进 → 写 normalized 骨骼 → 各角色 vrm.update → controls.update → render
 *
 *  实时录制时**不经过 ClipPlayer**：重定向后的姿态直传给 runtime。
 *  停止录制后才切到 ClipPlayer 回放生成的正式 clip，
 *  这样"最终看到的"与"动作库里播放的"必然是同一个东西。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { VrmScene, type VrmSlot } from '@/lib/vrm-scene';
import { ClipPlayer, withBasePose, type ClipSnapshot } from '@/lib/clip-player';
import type { ClipFile } from '@/lib/clip-spec';
import type { Pose } from '@/lib/pose';

export type PreviewMode = 'live' | 'clip';

export interface PreviewStatus {
  /** 已加载的角色 */
  slots: { id: string; url: string; bones: number; missing: string[] }[];
  /** 最近一帧实际调用 vrm.update 的次数（单角色应为 1，双角色应为 2） */
  lastFrameUpdates: number;
  /** 姿态写入失败的骨骼（正常应为空） */
  applyError: string | null;
}

export interface MocapPreviewHandle {
  loadSecond(url: string): Promise<void>;
  removeSecond(): void;
  /** 推入实时姿态（录制中）。传 null 表示这一帧没有有效数据 */
  setLivePose(pose: Pose | null): void;
  playClip(clip: ClipFile, opts?: { loop?: boolean; fadeIn?: number }): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(seconds: number): void;
  resetToBase(): void;
  setSkeletonVisible(visible: boolean): void;
  setMode(mode: PreviewMode): void;
  getSnapshot(): ClipSnapshot;
  getStatus(): PreviewStatus;
}

interface Props {
  primaryUrl: string;
  secondUrl?: string;
  showSecond: boolean;
  initialMode?: PreviewMode;
  onReady?: () => void;
  onError?: (msg: string) => void;
}

const MocapVrmPreview = forwardRef<MocapPreviewHandle, Props>(function MocapVrmPreview(
  { primaryUrl, secondUrl, showSecond, initialMode = 'live', onReady, onError },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<VrmScene | null>(null);
  const playerRef = useRef<ClipPlayer | null>(null);
  const modeRef = useRef<PreviewMode>(initialMode);
  const livePoseRef = useRef<Pose | null>(null);
  const applyErrorRef = useRef<string | null>(null);
  /** 每帧从两个 runtime 累加的 vrm.update 次数 */
  const frameUpdatesRef = useRef(0);
  const readyRef = useRef(false);
  /** 场景就绪信号。第二角色的加载必须等它 —— 否则 effect 跑在场景还没建好的时候，
   *  会静默什么都不做，表现为"勾了双角色没反应"。 */
  const [sceneReady, setSceneReady] = useState(false);

  const player = useMemo(() => new ClipPlayer(), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;

    const scene = new VrmScene(mount, { background: 0x1b2326 });
    sceneRef.current = scene;
    playerRef.current = player;
    const resizeObserver = new ResizeObserver(() => {
      scene.resize();
      scene.frameCamera();
    });
    resizeObserver.observe(mount);

    (async () => {
      try {
        await scene.loadSlot('primary', primaryUrl);
        if (cancelled) return;
        // 加载后先写基础站姿：normalized 骨骼的初始姿态是 T-pose，不是待机姿态
        for (const slot of scene.getSlots()) {
          slot.runtime.applyBasePose();
          slot.runtime.commit(0);
        }
        scene.frameCamera();
        readyRef.current = true;
        setSceneReady(true);
        onReady?.();
      } catch (e) {
        if (!cancelled) onError?.(e instanceof Error ? e.message : String(e));
      }
    })();

    scene.start((dt) => {
      const mode = modeRef.current;
      let pose: Pose;
      if (mode === 'clip') {
        pose = player.update(dt);
      } else {
        pose = livePoseRef.current ?? {};
      }

      let updates = 0;
      let err: string | null = null;

      for (const slot of scene.getSlots()) {
        const bones = slot.runtime.getBones();
        // withBasePose 把没被动作覆盖的骨骼补成基础站姿（而不是留在 T-pose）
        const res = slot.runtime.applyPose(withBasePose(pose, bones));
        if (!res.ok && res.missing.length) {
          err = `${slot.id} 缺骨骼：${res.missing.join(', ')}`;
        }
        // ★ 全流程唯一调用 vrm.update 的地方
        updates += slot.runtime.commit(dt);
      }
      frameUpdatesRef.current = updates;
      applyErrorRef.current = err;
    });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      scene.stop();
      player.reset();
      scene.dispose();
      sceneRef.current = null;
      playerRef.current = null;
      readyRef.current = false;
      setSceneReady(false);
    };
    // 只随 primaryUrl 重建场景；切换第二角色用命令式接口，避免重建 WebGL 上下文
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryUrl, player]);

  // 第二角色的加载/卸载做成命令式，避免调一次开关就重建整个场景
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !readyRef.current) return;
    if (showSecond && secondUrl && !scene.getSlot('second')) {
      scene
        .loadSlot('second', secondUrl)
        .then(() => {
          const slot = scene.getSlot('second');
          slot?.runtime.applyBasePose();
          slot?.runtime.commit(0);
          scene.frameCamera();
        })
        .catch((e) => onError?.(e instanceof Error ? e.message : String(e)));
    } else if (!showSecond && scene.getSlot('second')) {
      const slot = scene.getSlot('second');
      if (slot) {
        slot.runtime.applyPose({}).ok;
      }
      scene.removeSlot('second');
    }
    // sceneReady 必须在依赖里：它从 false 变 true 时才真正去加载第二角色
  }, [showSecond, secondUrl, onError, sceneReady]);

  const getStatus = useCallback((): PreviewStatus => {
    const scene = sceneRef.current;
    return {
      slots: (scene?.getSlots() ?? []).map((s: VrmSlot) => ({
        id: s.id,
        url: s.url,
        bones: s.runtime.getBones().length,
        missing: s.capabilities.missingBones ?? [],
      })),
      lastFrameUpdates: frameUpdatesRef.current,
      applyError: applyErrorRef.current,
    };
  }, []);

  useImperativeHandle(
    ref,
    (): MocapPreviewHandle => ({
      async loadSecond(url: string) {
        const scene = sceneRef.current;
        if (!scene) throw new Error('场景尚未就绪');
        if (scene.getSlot('second')) return;
        await scene.loadSlot('second', url);
        const slot = scene.getSlot('second');
        slot?.runtime.applyBasePose();
        slot?.runtime.commit(0);
        scene.frameCamera();
      },
      removeSecond() {
        sceneRef.current?.removeSlot('second');
      },
      setLivePose(pose: Pose | null) {
        livePoseRef.current = pose;
      },
      async playClip(clip: ClipFile, opts) {
        modeRef.current = 'clip';
        await player.play(clip, { loop: opts?.loop ?? false, fadeIn: opts?.fadeIn });
      },
      pause() {
        player.pause();
      },
      resume() {
        player.resume();
      },
      stop() {
        player.stop();
      },
      seek(seconds: number) {
        player.seek(seconds);
      },
      resetToBase() {
        modeRef.current = 'live';
        livePoseRef.current = null;
        // 用 reset() 而不是 stop()：stop 会进 fadeOut，渲染循环每帧把旧动作写回去，
        // 把手动姿态覆盖掉（G1 踩过这个坑）
        player.reset();
        for (const slot of sceneRef.current?.getSlots() ?? []) slot.runtime.applyBasePose();
      },
      setSkeletonVisible(visible: boolean) {
        sceneRef.current?.setSkeletonVisible(visible);
      },
      setMode(mode: PreviewMode) {
        modeRef.current = mode;
      },
      getSnapshot() {
        return player.getSnapshot();
      },
      getStatus,
    }),
    [player, getStatus],
  );

  return <div className="mocap-preview-mount" ref={mountRef} />;
});

export default MocapVrmPreview;

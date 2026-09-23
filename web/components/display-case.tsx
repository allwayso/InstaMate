'use client';

/**
 * 角色调试台（A 泳道）。
 *
 * 渲染循环顺序**固定**（G1 计划）：
 *   ClipPlayer 推进/采样 → CharacterRuntime 写 normalized bones → vrm.update(delta) 一次
 *   → 相机控件更新 → 渲染
 *
 * 分工约束：
 * - 只有 CharacterRuntime 写身体骨骼（且只写 normalized，§七 禁止 normalized/raw 双写）
 * - ClipPlayer 不持有 VRM
 * - 播放与 UI 操作不重建 WebGL 场景；React state 只驱动 HUD
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadVrm, type LoadedVrm } from '@/lib/vrm-character';
import { CharacterRuntime } from '@/lib/character-runtime';
import { ClipPlayer, withBasePose, type ClipSnapshot } from '@/lib/clip-player';
import {
  fetchCatalog,
  importClipFromFile,
  loadClipFile,
  type ClipCatalogEntry,
} from '@/lib/clip-catalog';
import type { ClipFile } from '@/lib/clip-spec';
import type { Pose } from '@/lib/pose';
import { HUMAN_BONES_VRM1 as HUMAN_BONES } from '@/lib/contracts';
import type { VrmCapabilities } from '@/lib/contracts';
import AvatarSelect from '@/components/avatar-select';

const DEFAULT_AVATAR = '/avatars/sample.vrm';

interface StageInfo {
  capabilities: VrmCapabilities;
  heightM: number;
  centerY: number;
}

interface ClipApi {
  play: (id: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  seek: (t: number) => void;
  setLoop: (v: boolean) => void;
  applyBase: () => void;
  applyRest: () => void;
  toggleSkeleton: (v: boolean) => void;
  loadClip: (id: string) => Promise<ClipFile | null>;
  importFile: (f: File) => Promise<void>;
}

export default function DisplayCase({ src = DEFAULT_AVATAR }: { src?: string }) {
  // 选中的资产。初始值来自 props（?avatar=<url>），之后由 HUD 下拉控制。
  // 之所以要有内部 state：查询参数与用户选择是两条独立输入源，都归一到这里，
  // 加载 effect 只依赖它 —— 否则就要为两种入口各写一套加载逻辑。
  const [avatarUrl, setAvatarUrl] = useState(src);

  // props（?avatar=）变化时跟随。这里的 [src] 是【有意】的，别跟着改成 [avatarUrl]。
  useEffect(() => {
    setAvatarUrl(src);
  }, [src]);

  const mountRef = useRef<HTMLDivElement>(null);
  const helpersRef = useRef<THREE.Group | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const apiRef = useRef<ClipApi | null>(null);
  const skeletonRef = useRef<THREE.SkeletonHelper | null>(null);
  const runtimeRef = useRef<CharacterRuntime | null>(null);
  const playerRef = useRef<ClipPlayer | null>(null);
  const clipsRef = useRef<Map<string, ClipFile>>(new Map());
  const targetBonesRef = useRef<readonly string[] | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<StageInfo | null>(null);
  const [hudOpen, setHudOpen] = useState(true);
  const [shiftPan, setShiftPan] = useState(false);

  const [catalog, setCatalog] = useState<ClipCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [snapshot, setSnapshot] = useState<ClipSnapshot | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const [loop, setLoopState] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);

  // ---------------------------------------------------------------------------
  // 主场景（只在 src 变化时重建）
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let raf = 0;
    let loaded: LoadedVrm | null = null;
    let runtime: CharacterRuntime | null = null;
    let player: ClipPlayer | null = null;

    const width = mount.clientWidth || 960;
    const height = mount.clientHeight || 640;

    // --- renderer / scene / camera ---
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d24);
    const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);

    // --- 环绕检视 ---
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.85;
    controls.panSpeed = 0.8;
    controls.zoomSpeed = 0.9;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.25;
    controls.maxDistance = 40;

    // --- Shift 修饰键：只用于 HUD 提示，不碰 controls.mouseButtons ---
    // OrbitControls 已内置 Shift/Ctrl/Meta 反转（onMouseDown）：
    //   case MOUSE.ROTATE + shiftKey → PAN   （Shift + 左键 = 平移）
    //   case MOUSE.PAN   + shiftKey → ROTATE （Shift + 右键 = 旋转）
    // 手动改 mouseButtons.LEFT 会落进 PAN+shiftKey 分支反而变回旋转（实测踩过）。
    let lastPointerDown: { shiftKey: boolean; button: number; pointerType: string } | null = null;
    const onPointerDownCapture = (e: PointerEvent) => {
      lastPointerDown = { shiftKey: e.shiftKey, button: e.button, pointerType: e.pointerType };
    };
    mount.addEventListener('pointerdown', onPointerDownCapture, { capture: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPan(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPan(false);
    };
    const onBlur = () => setShiftPan(false);
    // 页面隐藏时挂起动作时钟，恢复后不突然跳到结尾
    const onVisibility = () => player?.setSuspended(document.hidden);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    const resetView = () => {
      const damping = controls.enableDamping;
      controls.enableDamping = false; // 非阻尼分支会在 update() 末尾清零 _panOffset/_sphericalDelta
      controls.reset();
      controls.update();
      controls.enableDamping = damping;
    };
    resetViewRef.current = resetView;

    // --- 三点光 ---
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.4, 2.2, 2.6);
    const fill = new THREE.DirectionalLight(0xc9d8ff, 0.9);
    fill.position.set(-2.2, 1.2, 1.8);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(-0.6, 1.8, -2.6);
    const ambient = new THREE.HemisphereLight(0xffffff, 0x333844, 0.55);
    scene.add(key, fill, rim, ambient);

    // --- 朝向辅助线 ---
    const helpers = new THREE.Group();
    helpers.name = 'debug-helpers';
    const axes = new THREE.AxesHelper(0.5);
    const facing = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.6, 0x00e5a0);
    helpers.add(axes, facing);
    helpers.visible = true;
    helpersRef.current = helpers;
    scene.add(helpers);

    // --- 加载 VRM ---
    loadVrm(avatarUrl)
      .then((result) => {
        if (cancelled) {
          result.dispose();
          return;
        }
        loaded = result;
        scene.add(result.root);

        runtime = new CharacterRuntime(result.vrm);
        player = new ClipPlayer();
        runtimeRef.current = runtime;
        playerRef.current = player;

        // 待机姿态 = 基础站姿（双臂自然下垂），**不是**参考姿态（参考姿态是 T-pose）
        runtime.applyBasePose();

        // 骨架辅助线（默认隐藏，用按钮开）
        const sk = new THREE.SkeletonHelper(result.vrm.scene);
        sk.visible = false;
        skeletonRef.current = sk;
        scene.add(sk);

        // 取景
        const box = new THREE.Box3().setFromObject(result.root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        helpers.scale.setScalar(Math.max(0.4, size.y * 0.25));

        const fovRad = (camera.fov * Math.PI) / 180;
        const fitHeight = size.y / (2 * Math.tan(fovRad / 2));
        const fitWidth = size.x / (2 * Math.tan(fovRad / 2) * camera.aspect);
        const distance = Math.max(fitHeight, fitWidth) * 1.45;

        camera.position.set(center.x, center.y + size.y * 0.04, center.z + distance);
        camera.near = Math.max(0.01, distance / 100);
        camera.far = distance * 40;
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.maxDistance = distance * 10;
        controls.update();
        controls.saveState();

        key.target.position.set(0, center.y, 0);
        key.target.updateMatrixWorld();

        setInfo({
          capabilities: result.capabilities,
          heightM: Number(size.y.toFixed(3)),
          centerY: Number(center.y.toFixed(3)),
        });

        // ---- 动作库：先加载 VRM 才知道目标骨骼，再拉目录与 clip ----
        const targetBones = result.capabilities.missingBones.length
          ? buildTargetBones(result.capabilities.missingBones)
          : null;
        targetBonesRef.current = targetBones;

        const api: ClipApi = {
          play: (id) => {
            const clip = clipsRef.current.get(id);
            if (!clip || !player) return;
            setSelectedId(id);
            setClipError(null);
            void player.play(clip, { loop }).catch((e: unknown) => {
              if (e instanceof Error && e.name === 'ClipPlaybackCancelledError') return; // 被取代属正常
              setClipError(e instanceof Error ? e.message : String(e));
            });
          },
          pause: () => player?.pause(),
          resume: () => player?.resume(),
          stop: () => {
            player?.stop();
          },
          seek: (t) => player?.seek(t),
          setLoop: (v) => {
            setLoopState(v);
            if (player) {
              const snap = player.getSnapshot();
              const clip = snap.name ? clipsRef.current.get(snap.name) : null;
              // 立刻对当前动作生效：从当前时刻重新起播
              if (clip) void player.play(clip, { loop: v, startTime: snap.time }).catch(() => {});
            }
          },
          // 用 reset() 而不是 stop()：stop() 会进入 fadeOut，渲染循环每帧仍会把
          // 旧动作的骨骼写回去，把手动设置的姿态覆盖掉（实测踩过）。
          applyBase: () => {
            player?.reset();
            runtime?.applyBasePose();
          },
          applyRest: () => {
            player?.reset();
            runtime?.applyRestPose();
          },
          toggleSkeleton: (v) => {
            setShowSkeleton(v);
            if (skeletonRef.current) skeletonRef.current.visible = v;
          },
          loadClip: async (id) => clipsRef.current.get(id) ?? null,
          importFile: async (f) => {
            const res = await importClipFromFile(f, catalog, targetBones);
            if (!res.ok || !res.clip || !res.entry) {
              setClipError(res.issues.filter((i) => i.level === 'ERROR').map((i) => `${i.rule}: ${i.msg}`).join('\n'));
              return;
            }
            clipsRef.current.set(res.entry.id, res.clip);
            setCatalog((prev) => [...prev.filter((c) => c.id !== res.entry!.id), res.entry!]);
            setSelectedId(res.entry.id);
            setClipError(null);
            void player!.play(res.clip, { loop }).catch(() => {});
          },
        };
        apiRef.current = api;

        void (async () => {
          try {
            const entries = await fetchCatalog();
            const valid: ClipCatalogEntry[] = [];
            for (const e of entries) {
              const res = await loadClipFile(e.url, { targetBones, expectedId: e.id });
              if (res.ok && res.clip && res.entry) {
                clipsRef.current.set(e.id, res.clip);
                valid.push({ ...e, ...res.entry, name: e.name, source: e.source ?? 'generated' });
              } else {
                setClipError(
                  `${e.id} 未能加载：` + res.issues.filter((i) => i.level === 'ERROR').map((i) => i.msg).join('；'),
                );
              }
            }
            if (!cancelled) {
              setCatalog(valid);
              if (valid.length > 0) setSelectedId(valid[0].id);
            }
          } catch (e) {
            if (!cancelled) setClipError(e instanceof Error ? e.message : String(e));
          }
        })();

        // G0/G1 证据出口：readView/readControls 实时读取；pose 探针供自动化验收
        (window as unknown as Record<string, unknown>).__vrmDebug = {
          src: avatarUrl,
          capabilities: result.capabilities,
          boundingBox: {
            heightM: Number(size.y.toFixed(3)),
            widthM: Number(size.x.toFixed(3)),
            depthM: Number(size.z.toFixed(3)),
            center: center.toArray().map((v) => Number(v.toFixed(3))),
          },
          renderer: renderer.info.render,
          readView: () => ({
            position: camera.position.toArray(),
            target: controls.target.toArray(),
            fov: camera.fov,
            distance: camera.position.distanceTo(controls.target),
            polar: controls.getPolarAngle(),
            azimuth: controls.getAzimuthalAngle(),
          }),
          readControls: () => ({
            mouseButtons: {
              LEFT: controls.mouseButtons.LEFT,
              MIDDLE: controls.mouseButtons.MIDDLE,
              RIGHT: controls.mouseButtons.RIGHT,
            },
            defaults: { ROTATE: THREE.MOUSE.ROTATE, DOLLY: THREE.MOUSE.DOLLY, PAN: THREE.MOUSE.PAN },
            enablePan: controls.enablePan,
            enableRotate: controls.enableRotate,
            enableZoom: controls.enableZoom,
            lastPointerDown,
          }),
          // ---- G1：动作与运行时 ----
          clips: {
            list: () => catalog.map((c) => ({ id: c.id, name: c.name, source: c.source, mask: c.mask })),
            ids: () => [...clipsRef.current.keys()],
            snapshot: () => player?.getSnapshot() ?? null,
            play: (id: string) => api.play(id),
            pause: () => api.pause(),
            resume: () => api.resume(),
            stop: () => api.stop(),
            seek: (t: number) => api.seek(t),
            setLoop: (v: boolean) => api.setLoop(v),
            applyBase: () => api.applyBase(),
            applyRest: () => api.applyRest(),
            toggleSkeleton: (v: boolean) => api.toggleSkeleton(v),
          },
          runtime: {
            updateCount: () => runtime?.getUpdateCount() ?? 0,
            lastFrameUpdates: () => runtime?.getLastFrameUpdateCount() ?? 0,
            boneNames: () => runtime?.getBones() ?? [],
            /** 读某骨骼 normalized 骨骼当前的局部四元数 */
            getNormalizedQuat: (name: string) => {
              const n = result.vrm.humanoid.getNormalizedBoneNode(name as never);
              return n ? n.quaternion.toArray() : null;
            },
            writeNormalizedQuat: (name: string, q: number[]) => {
              const n = result.vrm.humanoid.getNormalizedBoneNode(name as never);
              if (!n) return false;
              n.quaternion.set(q[0], q[1], q[2], q[3]).normalize();
              return true;
            },
            getBoneWorld: (name: string) => {
              const n = result.vrm.humanoid.getRawBoneNode(name as never);
              if (!n) return null;
              n.updateWorldMatrix(true, false);
              const p = new THREE.Vector3();
              const q = new THREE.Quaternion();
              const s = new THREE.Vector3();
              n.matrixWorld.decompose(p, q, s);
              return { pos: p.toArray(), quat: q.toArray() };
            },
            snapshotNormalized: () => {
              const rig = result.vrm.humanoid.normalizedHumanBones ?? {};
              const out: Record<string, number[]> = {};
              for (const [name, b] of Object.entries(rig)) {
                if (b && typeof b === 'object' && 'node' in b) {
                  out[name] = (b as { node: THREE.Object3D }).node.quaternion.toArray();
                }
              }
              return out;
            },
          },
          /** 兼容早先的姿态探针路径 */
          pose: {
            getNormalizedQuat: (name: string) => {
              const n = result.vrm.humanoid.getNormalizedBoneNode(name as never);
              return n ? n.quaternion.toArray() : null;
            },
            setNormalizedQuat: (name: string, q: number[], update = true) => {
              const n = result.vrm.humanoid.getNormalizedBoneNode(name as never);
              if (!n) return false;
              n.quaternion.set(q[0], q[1], q[2], q[3]).normalize();
              if (update) {
                scene.updateMatrixWorld(true);
                result.vrm.update(0);
                scene.updateMatrixWorld(true);
              }
              return true;
            },
            getBoneWorld: (name: string) => {
              const n = result.vrm.humanoid.getRawBoneNode(name as never);
              if (!n) return null;
              n.updateWorldMatrix(true, false);
              const p = new THREE.Vector3();
              const q = new THREE.Quaternion();
              const s = new THREE.Vector3();
              n.matrixWorld.decompose(p, q, s);
              return { pos: p.toArray(), quat: q.toArray() };
            },
            resetNormalized: () => {
              const rig = result.vrm.humanoid.normalizedHumanBones ?? {};
              for (const b of Object.values(rig)) {
                if (b && typeof b === 'object' && 'node' in b) {
                  (b as { node: THREE.Object3D }).node.quaternion.identity();
                }
              }
              scene.updateMatrixWorld(true);
              result.vrm.update(0);
              scene.updateMatrixWorld(true);
            },
          },
        };
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      });

    // --- 渲染循环：顺序固定，见文件头 ---
    const timer = new THREE.Timer();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      timer.update();
      const delta = Math.min(timer.getDelta(), 0.05); // §十：单步 delta 暂限 0.05 秒

      if (runtime && player) {
        const pose = player.update(delta);
        const bones = player.getBoneNames();
        // 只写参与合成的骨骼；未涉及的骨骼保持上一帧姿态（通常是基础站姿）
        if (bones.length > 0) runtime.applyPose(withBasePose(pose, bones) as Pose);
        runtime.commit(delta); // 全流程唯一一次 vrm.update
      }

      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const onResize = () => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      mount.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
      // 切角色/卸载：取消播放并释放旧引用
      player?.reset();
      if (skeletonRef.current) {
        scene.remove(skeletonRef.current);
        skeletonRef.current.dispose();
        skeletonRef.current = null;
      }
      loaded?.dispose();
      helpersRef.current = null;
      resetViewRef.current = null;
      apiRef.current = null;
      runtimeRef.current = null;
      playerRef.current = null;
      clipsRef.current.clear();
      controls.dispose();
      timer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [avatarUrl]);

  // HUD 的播放状态：低频轮询，避免每帧触发 React 重渲染
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current;
      setSnapshot(p ? p.getSnapshot() : null);
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const selected = catalog.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="stage">
      <div className="stage-canvas" ref={mountRef} />

      <div className={`stage-hud${hudOpen ? '' : ' is-collapsed'}`}>
        <button
          type="button"
          className="hud-collapse"
          aria-expanded={hudOpen}
          onClick={() => setHudOpen((v) => !v)}
        >
          {hudOpen ? '收起面板 ▸' : '◂ 调试面板'}
        </button>

        {hudOpen && (
          <>
            <strong>G0 · 静态资产</strong>

            <div className="hud-row">
              <AvatarSelect
                className="hud-select"
                ariaLabel="角色资产"
                value={avatarUrl}
                onChange={setAvatarUrl}
              />
            </div>
            {error ? (
              <div className="hud-error" role="alert">
                <div>加载失败</div>
                <code>{error}</code>
              </div>
            ) : info ? (
              <dl>
                <dt>asset</dt>
                <dd>{info.capabilities.assetName ?? '(未命名)'}</dd>
                <dt>specVersion</dt>
                <dd>
                  {info.capabilities.specVersion ?? '?'}（metaVersion {info.capabilities.metaVersion ?? '?'}）
                </dd>
                <dt>骨骼</dt>
                <dd>
                  {info.capabilities.boneCount} / 55
                  {info.capabilities.missingBones.length > 0 && <>，缺 {info.capabilities.missingBones.join(', ')}</>}
                </dd>
                <dt>表情 preset</dt>
                <dd>{info.capabilities.expressionsPreset.length}</dd>
                <dt>弹簧骨</dt>
                <dd>
                  {info.capabilities.springBoneGroups ?? '?'} 组 / {info.capabilities.springBoneJoints} 关节 /{' '}
                  {info.capabilities.springBoneColliders} 碰撞体
                </dd>
                <dt>lookAtType</dt>
                <dd>
                  {info.capabilities.lookAtType ?? '(none)'}
                  <em>（实测，未写死）</em>
                </dd>
                <dt>实测身高</dt>
                <dd>{info.heightM} m（包围盒，含头发）</dd>
                <dt>许可</dt>
                <dd>
                  {info.capabilities.creditNotation ?? '?'} · {info.capabilities.authors.join(', ') || '?'}
                </dd>
              </dl>
            ) : (
              <div className="hud-loading">加载中… {avatarUrl}</div>
            )}

            <hr className="hud-sep" />
            <strong>G1 · 动作</strong>

            <div className="hud-row">
              <select
                className="hud-select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                aria-label="动作选择"
              >
                <option value="">（未选择）</option>
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.source === 'imported' ? ' [导入]' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="hud-row">
              <button type="button" className="hud-toggle" onClick={() => apiRef.current?.play(selectedId)} disabled={!selectedId}>
                ▶ 播放
              </button>
              <button type="button" className="hud-toggle" onClick={() => apiRef.current?.pause()}>
                ⏸ 暂停
              </button>
              <button type="button" className="hud-toggle" onClick={() => apiRef.current?.resume()}>
                ⏵ 继续
              </button>
              <button type="button" className="hud-toggle" onClick={() => apiRef.current?.stop()}>
                ⏹ 停止
              </button>
            </div>

            <div className="hud-row">
              <label className="hud-check">
                <input
                  type="checkbox"
                  checked={loop}
                  onChange={(e) => apiRef.current?.setLoop(e.target.checked)}
                />
                循环
              </label>
              <label className="hud-check">
                <input
                  type="checkbox"
                  checked={showSkeleton}
                  onChange={(e) => apiRef.current?.toggleSkeleton(e.target.checked)}
                />
                骨架
              </label>
            </div>

            <input
              className="hud-range"
              type="range"
              min={0}
              max={Math.max(snapshot?.duration ?? 0, 0.001)}
              step={0.01}
              value={snapshot?.time ?? 0}
              onChange={(e) => apiRef.current?.seek(Number(e.target.value))}
              aria-label="时间轴"
            />
            <div className="hud-time">
              {(snapshot?.time ?? 0).toFixed(2)}s / {(snapshot?.duration ?? 0).toFixed(2)}s
              <span className="hud-state">
                {snapshot?.state ?? 'idle'}
                {snapshot && snapshot.weight < 1 ? ` w=${snapshot.weight.toFixed(2)}` : ''}
                {snapshot?.outgoing ? ` ← ${snapshot.outgoing}` : ''}
              </span>
            </div>

            <div className="hud-row">
              <button type="button" className="hud-toggle" onClick={() => apiRef.current?.applyBase()}>
                恢复基础站姿
              </button>
              <button type="button" className="hud-toggle" onClick={() => apiRef.current?.applyRest()}>
                参考姿态
              </button>
            </div>

            <div className="hud-row">
              <label className="hud-file">
                导入 JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void apiRef.current?.importFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            <dl className="hud-clipinfo">
              <dt>mask</dt>
              <dd>{selected ? selected.mask.join(', ') || '(空)' : '—'}</dd>
              <dt>缺失骨骼</dt>
              <dd>
                {info?.capabilities.missingProjectBones.length
                  ? info.capabilities.missingProjectBones.join(', ')
                  : '无'}
              </dd>
            </dl>

            {clipError && (
              <div className="hud-error" role="alert">
                <div>动作错误（已保留原动作/姿态）</div>
                <code>{clipError}</code>
              </div>
            )}

            <button type="button" className="hud-toggle" onClick={() => resetViewRef.current?.()}>
              归位视角
            </button>

            <p className="hud-hint">
              旋转：左键拖动（或单指）· <strong>Shift + 右键</strong>（反转）
              <br />
              平移：<strong>Shift + 左键拖动</strong> · 或右键拖动 · 或双指
              <br />
              缩放：滚轮 · 或双指
              {shiftPan && (
                <em className="hud-mode">按住 Shift：左键 = 平移 ／ 右键 = 旋转（OrbitControls 内置反转）</em>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** 由 manifest 的 missingBones 推出目标资产实际拥有的骨骼 */
function buildTargetBones(missingBones: readonly string[]): readonly string[] {
  const missing = new Set(missingBones);
  // 与 tools/validate-clip.mjs 的 --target 同一算法：规范表减去缺失项
  return HUMAN_BONES.filter((b) => !missing.has(b));
}


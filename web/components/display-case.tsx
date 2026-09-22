'use client';

/**
 * 静态 VRM 展示台（A 泳道）。
 *
 * 本轮范围：只证明"能加载 + 材质与朝向正确 + 无阻断错误"（G0）。
 * 不做注视 / lookAt 追踪 / 程序化抬手 —— 那些是下一步。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadVrm, type LoadedVrm } from '@/lib/vrm-character';
import type { VrmCapabilities } from '@/lib/contracts';

const DEFAULT_AVATAR = '/avatars/sample.vrm';

interface StageInfo {
  capabilities: VrmCapabilities;
  heightM: number;
  centerY: number;
}

export default function DisplayCase({ src = DEFAULT_AVATAR }: { src?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const helpersRef = useRef<THREE.Group | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<StageInfo | null>(null);
  const [showHelpers, setShowHelpers] = useState(true);
  const [hudOpen, setHudOpen] = useState(true);
  const [shiftPan, setShiftPan] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let raf = 0;
    let loaded: LoadedVrm | null = null;

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

    // --- 环绕检视：左键拖动旋转 / 右键拖动平移 / 滚轮缩放 / 双指平移+缩放 ---
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.85;
    controls.panSpeed = 0.8;
    controls.zoomSpeed = 0.9;
    controls.screenSpacePanning = true; // 平移跟随屏幕轴，检视角色时最直觉
    controls.minDistance = 0.25;
    controls.maxDistance = 40;

    // --- Shift 修饰键：**只用于 HUD 提示，不碰 controls.mouseButtons** ---
    //
    // ⚠️ OrbitControls 已内置 Shift/Ctrl/Meta 反转（源码 onMouseDown）：
    //      case MOUSE.ROTATE + shiftKey → PAN    （默认左键 → Shift+左键 = 平移）
    //      case MOUSE.PAN   + shiftKey → ROTATE  （默认右键 → Shift+右键 = 旋转）
    // 所以「Shift + 左键 = 平移」是库自带行为，**千万不要手动去改 mouseButtons.LEFT**：
    // 改了会落进 case MOUSE.PAN + shiftKey 分支，反而变回旋转（实测踩过这个坑）。
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    // 「归位视角」：关掉阻尼跑一次 update，让 OrbitControls 把 _panOffset/_sphericalDelta 清零，
    // 否则残留惯性会在归位后继续把相机推跑。
    const resetView = () => {
      const damping = controls.enableDamping;
      controls.enableDamping = false; // 非阻尼分支会在 update() 末尾把累加器归零
      controls.reset();
      controls.update();
      controls.enableDamping = damping;
    };
    resetViewRef.current = resetView;

    // --- 三点光（§十一 调试页基础） ---
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.4, 2.2, 2.6);
    const fill = new THREE.DirectionalLight(0xc9d8ff, 0.9);
    fill.position.set(-2.2, 1.2, 1.8);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(-0.6, 1.8, -2.6);
    const ambient = new THREE.HemisphereLight(0xffffff, 0x333844, 0.55);
    scene.add(key, fill, rim, ambient);

    // --- 朝向辅助线：G0 用它"确认"而不是"假设"角色面向 +Z（§七） ---
    const helpers = new THREE.Group();
    helpers.name = 'debug-helpers';
    const axes = new THREE.AxesHelper(0.5);
    const facing = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.6, 0x00e5a0);
    helpers.add(axes, facing);
    helpers.visible = true;
    helpersRef.current = helpers;
    scene.add(helpers);

    // --- 加载 VRM ---
    loadVrm(src)
      .then((result) => {
        if (cancelled) {
          result.dispose();
          return;
        }
        loaded = result;
        scene.add(result.root);

        // 静态取景：按包围盒把角色完整放进画面，正面朝向相机
        const box = new THREE.Box3().setFromObject(result.root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        helpers.position.set(0, 0, 0);
        helpers.scale.setScalar(Math.max(0.4, size.y * 0.25));

        const fovRad = (camera.fov * Math.PI) / 180;
        const fitHeight = size.y / (2 * Math.tan(fovRad / 2));
        const fitWidth = size.x / (2 * Math.tan(fovRad / 2) * camera.aspect);
        const distance = Math.max(fitHeight, fitWidth) * 1.45;

        camera.position.set(center.x, center.y + size.y * 0.04, center.z + distance);
        camera.near = Math.max(0.01, distance / 100);
        camera.far = distance * 40;
        camera.updateProjectionMatrix();

        // 以模型包围盒中心为环绕/平移的枢轴，并把初始取景存为“归位”状态
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

        // G0 证据出口：无头浏览器/控制台可直接读到实测值
        // readView() 是**实时**读取，用于自动化验证旋转/平移/缩放是否真的生效
        (window as unknown as Record<string, unknown>).__vrmDebug = {
          src,
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
          // 给自动化测试用的内部状态喷口：确认我们没有覆写 OrbitControls 的默认按钮映射
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
        };
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      });

    // --- 渲染循环（§十：每帧调用一次 vrm.update(delta)，不重复调用） ---
    // 用 THREE.Timer：three 0.186 已把 THREE.Clock 标为 @deprecated
    const timer = new THREE.Timer();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      timer.update();
      const delta = Math.min(timer.getDelta(), 0.05); // §十 第 1 步：单步 delta 暂限 0.05 秒
      if (loaded) {
        loaded.vrm.update(delta);
      }
      controls.update(); // 阻尼开启后必须每帧调用
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
      mount.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
      loaded?.dispose();
      helpersRef.current = null;
      controls.dispose();
      resetViewRef.current = null;
      timer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [src]);

  // 辅助线开关：只改可见性，不重建 WebGL 上下文
  useEffect(() => {
    if (helpersRef.current) helpersRef.current.visible = showHelpers;
  }, [showHelpers]);

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
          {hudOpen ? '收起面板 ▸' : '◂ G0 实测数据'}
        </button>

        {hudOpen && (
          <>
            <strong>G0 · 静态资产</strong>
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
                  {info.capabilities.specVersion ?? '?'}（metaVersion {info.capabilities.metaVersion ?? '?'}
                  ）
                </dd>
                <dt>骨骼</dt>
                <dd>
                  {info.capabilities.boneCount} / 55
                  {info.capabilities.missingBones.length > 0 && (
                    <>，缺 {info.capabilities.missingBones.join(', ')}</>
                  )}
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
                  {info.capabilities.creditNotation ?? '?'} ·{' '}
                  {info.capabilities.authors.join(', ') || '?'}
                </dd>
              </dl>
            ) : (
              <div className="hud-loading">加载中… {src}</div>
            )}

            <button type="button" className="hud-toggle" onClick={() => setShowHelpers((v) => !v)}>
              {showHelpers ? '隐藏' : '显示'}朝向辅助线
            </button>
            <button
              type="button"
              className="hud-toggle"
              onClick={() => resetViewRef.current?.()}
            >
              归位视角
            </button>

            <p className="hud-hint">
              旋转：左键拖动（或单指）· <strong>Shift + 右键</strong>（反转）
              <br />
              平移：<strong>Shift + 左键拖动</strong> · 或右键拖动 · 或双指
              <br />
              缩放：滚轮 · 或双指
              {shiftPan && (
                <em className="hud-mode">
                  按住 Shift：左键 = 平移 ／ 右键 = 旋转（OrbitControls 内置反转）
                </em>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

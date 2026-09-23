/**
 * VRM 场景基建：renderer / scene / 相机 / 灯光 / 角色槽位。
 *
 * 从 G1 的 display-case.tsx 抽出同样的搭建方式（同样的灯光与取景算法，
 * 保证两个页面的观感一致），但**只给 G2 的新页面用** —— 不回头改 display-case，
 * 以免动到已经通过 20/20 验收的那段代码。
 *
 * 【后续可合并】两处场景搭建将来应当统一到这里，display-case 也换过来。
 *
 * 明确的职责边界：
 *   · 本模块**不写任何骨骼旋转**。骨骼只由 CharacterRuntime 写（G1 §七 的硬约束）。
 *   · 渲染循环的顺序固定：调用方先做「播放器推进 + 写骨骼 + vrm.update」，
 *     之后本模块才 controls.update() + render()。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadVrm, type LoadedVrm } from './vrm-character.ts';
import { CharacterRuntime } from './character-runtime.ts';
import type { VrmCapabilities } from './contracts.ts';

export interface VrmSlot {
  id: string;
  url: string;
  vrm: LoadedVrm['vrm'];
  root: THREE.Group;
  capabilities: VrmCapabilities;
  /** ★ 唯一允许写骨骼的对象 */
  runtime: CharacterRuntime;
  /** 加载时的取景信息，多角色排列时用得上 */
  size: THREE.Vector3;
  center: THREE.Vector3;
}

export interface VrmSceneOptions {
  background?: number;
  /** 关闭轨道控制器（例如把场景嵌进固定视角的卡片里） */
  controls?: boolean;
  /** 诊断录制要在另一个画布中复制当前帧。 */
  captureCanvas?: boolean;
}

export class VrmScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls | null;

  private mount: HTMLElement;
  private slots = new Map<string, VrmSlot>();
  private skeleton: THREE.SkeletonHelper | null = null;
  private raf: number | null = null;
  private lastTime = 0;
  private onFrameCb: ((dt: number) => void) | null = null;
  private disposed = false;

  constructor(mount: HTMLElement, opts: VrmSceneOptions = {}) {
    this.mount = mount;
    const width = mount.clientWidth || 640;
    const height = mount.clientHeight || 480;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: opts.captureCanvas ?? false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearAlpha(1);
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(opts.background ?? 0x1a1d24);

    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
    this.camera.position.set(0, 1.2, 3);

    // 灯光与 display-case 保持一致：主光 + 冷色补光 + 轮廓光 + 半球环境
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.5, 2.5, 2.5);
    const fill = new THREE.DirectionalLight(0xc9d8ff, 0.9);
    fill.position.set(-2, 1.2, 1.5);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(0, 2, -2.5);
    const ambient = new THREE.HemisphereLight(0xffffff, 0x333844, 0.55);
    this.scene.add(key, fill, rim, ambient);

    this.controls =
      opts.controls === false ? null : new OrbitControls(this.camera, this.renderer.domElement);
    if (this.controls) {
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.target.set(0, 1, 0);
      this.controls.update();
    }
  }

  /**
   * 加载一个角色。
   *
   * 两个角色用**各自的** CharacterRuntime，但共用同一个 scene 与 renderer ——
   * 这是计划要求的「不复制、不重算、不针对角色改 clip」的前提：
   * 同一份采样结果分别写进两个 runtime，再各提交一次。
   */
  async loadSlot(id: string, url: string): Promise<VrmSlot> {
    const loaded = await loadVrm(url);
    if (this.disposed) {
      loaded.dispose();
      throw new Error('场景已销毁');
    }
    this.scene.add(loaded.root);

    const box = new THREE.Box3().setFromObject(loaded.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const slot: VrmSlot = {
      id,
      url,
      vrm: loaded.vrm,
      root: loaded.root,
      capabilities: loaded.capabilities,
      runtime: new CharacterRuntime(loaded.vrm),
      size,
      center,
    };
    this.slots.set(id, slot);
    this.arrange();
    return slot;
  }

  removeSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.scene.remove(slot.root);
    this.slots.delete(id);
    this.arrange();
  }

  getSlot(id: string): VrmSlot | undefined {
    return this.slots.get(id);
  }

  getSlots(): VrmSlot[] {
    return [...this.slots.values()];
  }

  /** 两个角色左右并排（各自独立 runtime，共用 scene/renderer） */
  private arrange(): void {
    const list = [...this.slots.values()];
    if (list.length === 0) return;

    const gap = 0.42; // 左右之间的额外间隙（米）
    const widths = list.map((s) => s.size.x);
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, list.length - 1);
    let x = -totalW / 2;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const cx = x + widths[i] / 2;
      // 用包围盒中心对齐到原点：不同角色原点位置不同（Seed-san 原点在脚底）
      s.root.position.set(cx - s.center.x, -s.center.y + s.size.y / 2, -s.center.z);
      x += widths[i] + gap;
    }
    this.frameCamera();
  }

  /** 自动取景：把当前所有角色装进画面 */
  frameCamera(): void {
    const list = [...this.slots.values()];
    if (list.length === 0) return;
    const box = new THREE.Box3();
    for (const s of list) box.expandByObject(s.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const fovRad = (this.camera.fov * Math.PI) / 180;
    const fitHeight = size.y / (2 * Math.tan(fovRad / 2));
    const fitWidth = size.x / (2 * Math.tan(fovRad / 2) * this.camera.aspect);
    const margin = list.length > 1 ? 1.28 : 1.12;
    const distance = Math.max(fitHeight, fitWidth) * margin;

    this.camera.position.set(center.x, center.y + size.y * 0.04, center.z + distance);
    this.camera.near = Math.max(0.01, distance / 100);
    this.camera.far = distance * 40;
    this.camera.updateProjectionMatrix();
    if (this.controls) {
      this.controls.target.set(center.x, center.y, center.z);
      this.controls.update();
    } else {
      this.camera.lookAt(center.x, center.y, center.z);
    }
  }

  /**
   * 骨架辅助线。默认挂在第一个角色上；多角色时只显示第一个，
   * 避免两套骨架叠在一起看不清。
   */
  setSkeletonVisible(visible: boolean): void {
    const first = [...this.slots.values()][0];
    if (!first) return;
    if (visible && !this.skeleton) {
      this.skeleton = new THREE.SkeletonHelper(first.vrm.scene);
      this.scene.add(this.skeleton);
    }
    if (this.skeleton) this.skeleton.visible = visible;
  }

  /**
   * 启动渲染循环。
   *
   * `onFrame(dt)` 里调用方应当完成：播放器推进 → 写骨骼 → vrm.update。
   * 本模块随后才做 controls.update() 与 render() —— 顺序固定，不要调换。
   */
  start(onFrame: (dt: number) => void): void {
    this.onFrameCb = onFrame;
    this.lastTime = performance.now();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      // 上限 0.1s：标签页切回来时不要用巨大 dt 一次跳完整段动作
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;

      this.onFrameCb?.(dt);
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  resize(): void {
    const w = this.mount.clientWidth;
    const h = this.mount.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 每帧实际调用 vrm.update 的次数（供自动化断言，会被重置） */
  private frameUpdates = 0;

  resetFrameCounter(): void {
    this.frameUpdates = 0;
  }

  get lastFrameUpdates(): number {
    return this.frameUpdates;
  }

  noteUpdate(): void {
    this.frameUpdates++;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.controls?.dispose();
    if (this.skeleton) this.scene.remove(this.skeleton);
    for (const s of this.slots.values()) {
      this.scene.remove(s.root);
      // 用 slot 的 vrm 反查释放（loadVrm 返回的 dispose 已包装在 slot 生命周期外，
      // 这里逐个释放 geometry/material，避免 rAF 停了但显存不还）
      s.vrm.scene.traverse((obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
        else mat?.dispose?.();
      });
    }
    this.slots.clear();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.mount) {
      this.mount.removeChild(this.renderer.domElement);
    }
  }
}

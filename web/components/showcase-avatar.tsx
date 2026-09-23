'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { VrmScene, type VrmSlot } from '@/lib/vrm-scene';
import { showcaseAssets } from '@/lib/showcase-assets';
import styles from '@/app/showcase/showcase.module.css';

const TURN_DURATION_MS = 18_000;
const EXPLOSION_DURATION_MS = 1_050;
const SCATTER_PAUSE_MS = 280;
const ASSEMBLY_DURATION_MS = 2_900;
const PARTICLE_COLUMNS = 60;
const PARTICLE_ROWS = 80;
const PARTICLE_COUNT = PARTICLE_COLUMNS * PARTICLE_ROWS;

type ParticleCloud = {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  starts: Float32Array;
  bursts: Float32Array;
  targets: Float32Array;
  delays: Float32Array;
};

function createParticleCloud(
  scene: VrmScene,
  slot: VrmSlot,
  mount: HTMLElement,
  photo: HTMLImageElement,
): ParticleCloud {
  const meshes: THREE.Mesh[] = [];
  let vertexCount = 0;
  slot.root.updateWorldMatrix(true, true);
  slot.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const count = object.geometry.getAttribute('position')?.count ?? 0;
    if (count === 0) return;
    meshes.push(object);
    vertexCount += count;
  });
  if (vertexCount === 0) throw new Error('VRM 模型没有可用的顶点');

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = PARTICLE_COLUMNS;
  sampleCanvas.height = PARTICLE_ROWS;
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sampleContext) throw new Error('无法读取照片像素');
  sampleContext.drawImage(photo, 0, 0, PARTICLE_COLUMNS, PARTICLE_ROWS);
  const imageData = sampleContext.getImageData(0, 0, PARTICLE_COLUMNS, PARTICLE_ROWS).data;

  const photoRect = photo.getBoundingClientRect();
  const mountRect = mount.getBoundingClientRect();
  const modelCenter = slot.root.position.clone().add(slot.center);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const photoPoint = new THREE.Vector3();
  const modelPoint = new THREE.Vector3();
  const tint = new THREE.Color('#b8ffe5');
  const color = new THREE.Color();
  const starts = new Float32Array(PARTICLE_COUNT * 3);
  const bursts = new Float32Array(PARTICLE_COUNT * 3);
  const targets = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const delays = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const column = i % PARTICLE_COLUMNS;
    const row = Math.floor(i / PARTICLE_COLUMNS);
    const screenX = photoRect.left + ((column + .5) / PARTICLE_COLUMNS) * photoRect.width;
    const screenY = photoRect.top + ((row + .5) / PARTICLE_ROWS) * photoRect.height;
    ndc.set(
      ((screenX - mountRect.left) / mountRect.width) * 2 - 1,
      1 - ((screenY - mountRect.top) / mountRect.height) * 2,
    );
    raycaster.setFromCamera(ndc, scene.camera);
    const distance = (modelCenter.z - raycaster.ray.origin.z) / raycaster.ray.direction.z;
    photoPoint.copy(raycaster.ray.direction).multiplyScalar(distance).add(raycaster.ray.origin);

    let vertexIndex = Math.floor(Math.random() * vertexCount);
    let mesh = meshes[0];
    for (const candidate of meshes) {
      const count = candidate.geometry.getAttribute('position').count;
      if (vertexIndex < count) {
        mesh = candidate;
        break;
      }
      vertexIndex -= count;
    }
    modelPoint.fromBufferAttribute(mesh.geometry.getAttribute('position'), vertexIndex);
    if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(vertexIndex, modelPoint);
    mesh.localToWorld(modelPoint);

    const offset = i * 3;
    starts[offset] = photoPoint.x;
    starts[offset + 1] = photoPoint.y;
    starts[offset + 2] = photoPoint.z;
    bursts[offset] = photoPoint.x + (photoPoint.x - modelCenter.x) * 1.35 + (Math.random() - .5) * 1.25;
    bursts[offset + 1] = photoPoint.y + (photoPoint.y - modelCenter.y) * 1.35 + (Math.random() - .5) * 1.2;
    bursts[offset + 2] = photoPoint.z + (Math.random() - .5) * 1.1;
    targets[offset] = modelPoint.x;
    targets[offset + 1] = modelPoint.y;
    targets[offset + 2] = modelPoint.z;
    delays[i] = Math.random() * .46;

    const pixel = i * 4;
    color.setRGB(
      imageData[pixel] / 255,
      imageData[pixel + 1] / 255,
      imageData[pixel + 2] / 255,
      THREE.SRGBColorSpace,
    ).lerp(tint, .18);
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(starts.slice(), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: .023,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: .98,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 1;
  return { points, starts, bursts, targets, delays };
}

type ShowcaseAvatarProps = {
  startAssembly: boolean;
  photoRef: RefObject<HTMLImageElement | null>;
  onReady: () => void;
};

export default function ShowcaseAvatar({ startAssembly, photoRef, onReady }: ShowcaseAvatarProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const beginRef = useRef<() => void>(() => {});
  const requestedRef = useRef(startAssembly);
  const [error, setError] = useState(false);

  useEffect(() => {
    requestedRef.current = startAssembly;
    if (startAssembly) beginRef.current();
  }, [startAssembly]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let scene: VrmScene;
    let slot: VrmSlot | undefined;
    let cloud: ParticleCloud | undefined;
    let started = false;

    try {
      scene = new VrmScene(mount, { background: 0x101b20, controls: false });
    } catch {
      setError(true);
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const resizeObserver = new ResizeObserver(() => {
      scene.resize();
      if (!slot) return;
      const wasVisible = slot.root.visible;
      slot.root.visible = true;
      scene.frameCamera();
      slot.root.visible = wasVisible;
    });
    resizeObserver.observe(mount);

    beginRef.current = () => {
      if (!slot || started || disposed) return;
      started = true;

      if (reducedMotion.matches) {
        slot.root.visible = true;
        scene.start((delta) => slot?.runtime.commit(delta));
        return;
      }

      const photo = photoRef.current;
      if (!photo) {
        slot.root.visible = true;
        scene.start((delta) => slot?.runtime.commit(delta));
        return;
      }
      try {
        cloud = createParticleCloud(scene, slot, mount, photo);
      } catch {
        slot.root.visible = true;
        scene.start((delta) => slot?.runtime.commit(delta));
        return;
      }
      scene.scene.add(cloud.points);
      const explosionStart = performance.now();
      let turnStart: number | null = null;

      scene.start((delta) => {
        if (!slot) return;
        const now = performance.now();
        if (turnStart === null && cloud) {
          const elapsed = now - explosionStart;
          const positions = cloud.points.geometry.getAttribute('position') as THREE.BufferAttribute;
          const gathering = elapsed >= EXPLOSION_DURATION_MS + SCATTER_PAUSE_MS;
          const explosionProgress = Math.min(1, elapsed / EXPLOSION_DURATION_MS);
          const assemblyProgress = Math.min(
            1,
            Math.max(0, (elapsed - EXPLOSION_DURATION_MS - SCATTER_PAUSE_MS) / ASSEMBLY_DURATION_MS),
          );

          for (let i = 0; i < PARTICLE_COUNT; i++) {
            const offset = i * 3;
            let from = cloud.starts;
            let to = cloud.bursts;
            let eased = 1 - Math.pow(1 - explosionProgress, 3);
            if (gathering) {
              const local = Math.max(0, Math.min(1, (assemblyProgress - cloud.delays[i]) / (1 - cloud.delays[i])));
              eased = local * local * (3 - 2 * local);
              from = cloud.bursts;
              to = cloud.targets;
            }
            positions.setXYZ(
              i,
              from[offset] + (to[offset] - from[offset]) * eased,
              from[offset + 1] + (to[offset + 1] - from[offset + 1]) * eased,
              from[offset + 2] + (to[offset + 2] - from[offset + 2]) * eased,
            );
          }
          positions.needsUpdate = true;
          if (gathering && assemblyProgress >= .93) slot.root.visible = true;
          if (gathering && assemblyProgress >= .88) {
            cloud.points.material.opacity = Math.max(0, (1 - assemblyProgress) / .12);
          }
          if (gathering && assemblyProgress >= 1) {
            scene.scene.remove(cloud.points);
            cloud.points.geometry.dispose();
            cloud.points.material.dispose();
            cloud = undefined;
            turnStart = now;
          }
        } else if (turnStart !== null) {
          slot.root.rotation.y = ((now - turnStart) / TURN_DURATION_MS) * Math.PI * 2;
        }
        slot.runtime.commit(delta);
      });
    };

    void scene.loadSlot('showcase', showcaseAssets.avatar)
      .then((loaded) => {
        if (disposed) return;
        slot = loaded;
        slot.runtime.applyBasePose();
        slot.runtime.commit(0);
        scene.resize();
        scene.frameCamera();
        slot.root.visible = false;
        onReady();
        if (requestedRef.current) beginRef.current();
      })
      .catch(() => {
        if (!disposed) setError(true);
      });

    return () => {
      disposed = true;
      beginRef.current = () => {};
      resizeObserver.disconnect();
      if (cloud) {
        scene.scene.remove(cloud.points);
        cloud.points.geometry.dispose();
        cloud.points.material.dispose();
      }
      scene.dispose();
    };
  }, []);

  return (
    <div className={styles.avatarStage}>
      <div
        ref={mountRef}
        className={styles.avatarCanvas}
        role="img"
        aria-label="由照片粒子汇聚成形后缓慢旋转的 3D 影伴"
      />
      {error && <p className={styles.avatarStatus} role="status">影伴暂时无法显示，请检查 VRM 资源。</p>}
    </div>
  );
}

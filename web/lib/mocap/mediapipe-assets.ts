/** Shared asset metadata is JSON so both Node 20 and the browser can consume it. */
import manifest from './mediapipe-manifest.json' with { type: 'json' };

export const MEDIAPIPE_HOLISTIC_VERSION = manifest.version;
export const MEDIAPIPE_PACKAGE_DIR = manifest.packageDir;
export const VENDOR_URL_PATH = manifest.urlPath;
export const VENDOR_DIR = manifest.vendorDir;
export const DIRECT_REQUEST_FILES = manifest.directFiles;
// The SIMD branch has a zero-byte .data placeholder; the non-SIMD branch has none.
export const LOADER_ASSET_FILES = manifest.loaderFiles;
export const REQUIRED_VENDOR_FILES = [...DIRECT_REQUEST_FILES, ...LOADER_ASSET_FILES];
export const SKIPPED_VENDOR_FILES = manifest.skippedFiles;

/** Holistic 的固定配置。selfieMode 恒为 false —— 见 display-mapping.ts 的说明。 */
export const HOLISTIC_OPTIONS = {
  /** ★ 恒为 false：模型输入不镜像，镜像只在呈现层做 */
  selfieMode: false,
  /** 1 = pose_landmark_full.tflite */
  modelComplexity: 1,
  smoothLandmarks: true,
  enableSegmentation: false,
  refineFaceLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
} as const;

/** 摄像头采集参数 */
export const CAPTURE_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30 },
} as const;

/** 逐个 HEAD 请求检查 vendor 文件是否可达 */
export async function checkVendorFiles(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; missing: string[]; checked: number }> {
  const results = await Promise.all(
    REQUIRED_VENDOR_FILES.map(async (f) => {
      try {
        const res = await fetchImpl(`${VENDOR_URL_PATH}/${f}`, { method: 'HEAD', cache: 'no-store' });
        return { f, ok: res.ok };
      } catch {
        return { f, ok: false };
      }
    }),
  );
  const missing = results.filter((r) => !r.ok).map((r) => r.f);
  return { ok: missing.length === 0, missing, checked: results.length };
}

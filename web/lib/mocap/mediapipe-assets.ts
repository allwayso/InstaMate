/**
 * MediaPipe Holistic 的本地资源清单 —— **单一真相源**。
 *
 * 谁在用：
 *   · tools/sync-mediapipe.mjs   复制文件（Node 直接 import 本 .ts，沿用 G1 的做法）
 *   · holistic-session.ts        启动前自检，缺文件时明确报错
 *   · 页面                       显示资源状态
 *
 * 清单怎么来的：不是抄文档，而是从 `@mediapipe/holistic/holistic.js` 里反查出它
 * 直接请求的文件名，再加上那些 loader .js 各自再去加载的二进制。
 * MediaPipe 对加载失败的表现是**卡住而不是报错**，所以宁可在这里列全、
 * 缺一个就大声失败，也不要让它静默挂在那里。
 */

/** 版本必须与 package.json 里钉的完全一致 —— 漂移会改文件名 */
export const MEDIAPIPE_HOLISTIC_VERSION = '0.5.1675471629';

/** npm 包目录（相对仓库根） */
export const MEDIAPIPE_PACKAGE_DIR = 'web/node_modules/@mediapipe/holistic';

/** 复制目标 = 浏览器访问路径（public/ 下的绝对 URL 路径） */
export const VENDOR_URL_PATH = '/vendor/mediapipe/holistic';

/** 复制目标（相对仓库根） */
export const VENDOR_DIR = 'web/public/vendor/mediapipe/holistic';

/**
 * holistic.js 里直接按名字请求的文件。
 * 反查命令（记录在此以便复核）：
 *   grep -oE '"[a-zA-Z0-9_.]+\.(wasm|data|js|tflite|binarypb)"' holistic.js | sort -u
 */
export const DIRECT_REQUEST_FILES = [
  'holistic.binarypb',
  'holistic_solution_packed_assets_loader.js',
  'holistic_solution_simd_wasm_bin.js',
  'holistic_solution_wasm_bin.js',
  'pose_landmark_lite.tflite',
  'pose_landmark_full.tflite',
] as const;

/**
 * 由上面那些 loader .js 再去加载的二进制。
 *
 * ★ 注意 simd 与非 simd 两个分支**不对称**（实测）：
 *     simd    分支: holistic_solution_simd_wasm_bin.js + .wasm + .data（0 字节占位）
 *     非 simd 分支: holistic_solution_wasm_bin.js + .wasm   ← **没有 .data**
 *   资产本体在 holistic_solution_packed_assets.data 里。
 *   按对称性猜会写出一个根本不存在的文件（第一次跑同步脚本就是这么栽的）。
 */
export const LOADER_ASSET_FILES = [
  'holistic_solution_packed_assets.data',
  'holistic_solution_simd_wasm_bin.wasm',
  'holistic_solution_simd_wasm_bin.data',
  'holistic_solution_wasm_bin.wasm',
] as const;

/** 必须齐全的文件 */
export const REQUIRED_VENDOR_FILES = [...DIRECT_REQUEST_FILES, ...LOADER_ASSET_FILES];

/**
 * 刻意不复制的大文件。
 * `pose_landmark_heavy.tflite` 27.7 MB，只在 `modelComplexity: 2` 时加载；
 * 我们固定用 1(full)。省掉它让 vendor 从 76 MB 降到约 38 MB。
 * 以后若要调 modelComplexity，把它挪进 REQUIRED_VENDOR_FILES 即可。
 */
export const SKIPPED_VENDOR_FILES = [
  { file: 'pose_landmark_heavy.tflite', reason: '仅 modelComplexity:2 需要，我们固定用 1(full)' },
] as const;

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
        const res = await fetchImpl(`${VENDOR_URL_PATH}/${f}`, { method: 'HEAD' });
        return { f, ok: res.ok };
      } catch {
        return { f, ok: false };
      }
    }),
  );
  const missing = results.filter((r) => !r.ok).map((r) => r.f);
  return { ok: missing.length === 0, missing, checked: results.length };
}

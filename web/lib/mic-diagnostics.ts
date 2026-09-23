/**
 * 麦克风失败的分类与解释。
 *
 * 为什么单独一个纯模块：浏览器抛出来的东西对用户毫无意义 ——
 *
 *     NotFoundError: Requested device not found
 *
 * 用户既不知道为什么，也不知道该怎么办。而这句英文背后可能对应**五种完全不同**的情况
 * （没有麦克风 / 权限被拒 / 被别的程序占用 / 参数不满足 / 非安全上下文），
 * 它们的处理办法没有一条是重合的。
 *
 * 所以这里做两件事：
 *   ① 把 DOMException 归类成有限的几种失败（`classifyMicFailure`）
 *   ② 给每种失败生成一句**说清原因 + 说明下一步**的中文（`describeMicFailure`）
 *
 * 保持纯函数：不改全局、不碰 navigator，输入就是「错误 + 设备列表」，
 * 这样在 Node 里能直接测。
 */

/** 麦克风失败的类型。顺序即匹配优先级。 */
export type MicFailure =
  | 'unsupported' // 浏览器根本没有录音 API
  | 'insecure' // 非 HTTPS / 非 localhost
  | 'denied' // 用户或系统拒绝授权
  | 'no-device' // 没有可用的录音设备（★ 最常见，也最容易误判成代码 bug）
  | 'busy' // 设备存在但被别的程序独占
  | 'constraints' // 参数不满足
  | 'unknown';

/** 只需要 kind 和 label —— 不依赖 MediaDeviceInfo，方便测试直接造数据。 */
export interface DeviceLike {
  kind?: string;
  label?: string;
}

/**
 * DOMException 的 name → 失败类型。
 *
 * 注意 `NotFoundError`：它同时表示「设备不存在」和「设备存在但当前不可用」。
 * 这一点很反直觉 —— 在 Windows 上，「外部麦克风」可以被登记在设备管理器里
 * 而状态是「未插入」，此时 enumerateDevices 甚至能列出它，getUserMedia 依然抛
 * NotFoundError。所以下面没有把「列到了设备」当成「一定能用」。
 */
const NAME_TO_FAILURE: Record<string, MicFailure> = {
  NotAllowedError: 'denied',
  PermissionDeniedError: 'denied', // 旧 Chrome / Firefox
  SecurityError: 'insecure',
  NotFoundError: 'no-device',
  DevicesNotFoundError: 'no-device', // 旧 Firefox
  OverconstrainedError: 'constraints',
  ConstraintNotSatisfiedError: 'constraints',
  NotReadableError: 'busy',
  TrackStartError: 'busy', // 旧 Chrome
  AbortError: 'busy',
};

export function classifyMicFailure(error: unknown): MicFailure {
  if (!error || typeof error !== 'object') return 'unknown';
  const name = String((error as { name?: unknown }).name ?? '');
  return NAME_TO_FAILURE[name] ?? 'unknown';
}

/** 去掉括号里的厂商后缀之类噪音？不 —— label 对用户辨认设备有用，原样保留。 */
export function audioInputLabels(devices: readonly DeviceLike[]): string[] {
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => (d.label ?? '').trim())
    .filter((label) => label.length > 0);
}

/** 「系统里登记了 N 个录音设备：· a · b」—— 只在真的有设备时才写这段。 */
function enumerateHint(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  return (
    `\n\n系统里登记了 ${labels.length} 个录音设备，但它们当前都不可用：\n` +
    labels.map((l) => `  · ${l}`).join('\n') +
    '\n如果确实是插着的，检查它是否被禁用、或在别处被占用。'
  );
}

export interface DescribeOptions {
  /** enumerateDevices() 里 kind === 'audioinput' 的 label */
  labels?: readonly string[];
  /** 原始错误消息，附在末尾供排查（不替代中文解释） */
  detail?: string;
  /** OverconstrainedError 时是哪条约束 */
  constraint?: string;
}

/**
 * 把失败类型写成「原因 + 下一步」。
 *
 * 原则：**先说发生了什么，再说能做什么**。不说「请重试」这种废话 ——
 * 除 unknown 外每种失败都有明确的动作，那才是用户要的。
 */
export function describeMicFailure(failure: MicFailure, options: DescribeOptions = {}): string {
  const labels = options.labels ?? [];
  const detail = options.detail?.trim();
  const tail = detail ? `\n\n（原始信息：${detail}）` : '';

  switch (failure) {
    case 'unsupported':
      return '这个浏览器无法录音：缺少 navigator.mediaDevices.getUserMedia。换新版 Chrome / Edge / Firefox 试试。';

    case 'insecure':
      return '浏览器只在 HTTPS 或 localhost 下允许访问麦克风。请用 http://localhost:3000 打开，而不是用 IP 地址（例如 192.168.x.x）访问。';

    case 'denied':
      return '麦克风权限被拒绝。点地址栏左侧的图标，把「麦克风」改成「允许」，然后刷新页面。' + tail;

    case 'no-device':
      return (
        '没有检测到可用的麦克风。请插入或启用一个录音设备后重试（USB 麦克风、带麦的耳机、或摄像头自带麦克风）。' +
        enumerateHint(labels) +
        tail
      );

    case 'busy':
      return (
        '麦克风被其它程序占用了（会议、直播、录制软件都会独占它）。关掉那些程序再试。' + tail
      );

    case 'constraints':
      return (
        `没有麦克风能满足请求的参数${options.constraint ? `（${options.constraint}）` : ''}。` +
        '可能是设备只支持特定采样率或声道数。' +
        tail
      );

    default:
      return '无法启动麦克风。' + (labels.length ? `\n\n可用设备：\n${labels.map((l) => `  · ${l}`).join('\n')}` : '') + tail;
  }
}

/**
 * 出错后补一次设备枚举，把「系统里到底有没有录音设备」带进错误信息里。
 *
 * 为什么值得单独一步：用户看到「找不到设备」的第一反应是「我明明插着」。
 * 把设备名列出来，能立刻把问题从「你们的代码坏了」变成
 * 「原来系统认为它是未就绪状态」—— 这决定了下一步去哪修。
 */
export async function collectAudioInputLabels(
  enumerate: () => Promise<readonly DeviceLike[]>,
): Promise<string[]> {
  try {
    return audioInputLabels(await enumerate());
  } catch {
    // 枚举本身失败（例如权限被拒）不该掩盖原始错误
    return [];
  }
}

/** Browser error names are more stable than browser-specific/localized messages. */
export function describeCameraError(cause: unknown): string {
  const name = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限未开启。请在浏览器地址栏的网站权限中允许摄像头，然后重试。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到摄像头。连接设备后，再次启动摄像头。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头暂时无法使用。请关闭可能占用它的应用，然后重试。';
    case 'OverconstrainedError':
      return '所选摄像头已不可用或不支持当前设置。请选择默认设备后重试。';
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
}

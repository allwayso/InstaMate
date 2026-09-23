export type MachineState =
  | 'camera-off' | 'loading-model' | 'detecting' | 'calibrating' | 'ready'
  | 'countdown' | 'recording' | 'processing' | 'reviewing' | 'saving' | 'error';

/** Retrying a failed camera must re-enter loading, then become recordable. */
export function stateAfterCameraStatus(
  current: MachineState,
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'error',
  skipCalibration: boolean,
): MachineState {
  const canStart = current === 'camera-off' || current === 'loading-model' || current === 'error';
  if (status === 'starting' && canStart) return 'loading-model';
  if (status === 'running' && canStart) return skipCalibration ? 'ready' : 'detecting';
  if (status === 'error') return 'error';
  if (status === 'stopped') return 'camera-off';
  return current;
}

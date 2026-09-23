'use client';

/**
 * 轻量状态机事件总线：连接「对话 tool_call / 手动点击」与「角色表演」。
 * 状态库 UI、对话回复与 VRM 播放器订阅同一事件。
 */

export interface ActiveState {
  id: string;
  name: string;
  duration: number | null;
  loop: boolean;
  clipId: string | null;
  emotion: string;
  source: 'chat' | 'manual';
}

type Listener = (state: ActiveState | null) => void;

const listeners = new Set<Listener>();
let current: ActiveState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const DEFAULT_SHOW_MS = 5_000;

function emit() {
  for (const listener of listeners) listener(current);
}

export function getActiveState(): ActiveState | null {
  return current;
}

/** 触发一个状态；loop 状态持续到手动停止，非 loop 状态按 duration（缺省 5s）自动回 idle */
export function triggerState(state: Omit<ActiveState, 'source'>, source: ActiveState['source'] = 'manual') {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  current = { ...state, source };
  emit();
  if (!current.loop) {
    const showMs = Math.min(Math.max((current.duration ?? DEFAULT_SHOW_MS / 1000) * 1000, 1_500), 60_000);
    timer = setTimeout(() => {
      current = null;
      emit();
    }, showMs);
  }
}

/** 手动停止 loop 状态 / 立即回 idle */
export function stopState() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (current) {
    current = null;
    emit();
  }
}

export function onStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

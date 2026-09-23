'use client';

/**
 * 录制裁剪时间轴：拖入点/出点，最短 0.5 秒。
 *
 * 刻意做成受控组件（入点出点由父组件持有）：
 * 父组件要拿同一对数去调 buildClip，两处各自维护状态必然会不一致。
 *
 * 交互用 Pointer Events 而不是 Mouse Events：一并支持触摸屏，且拖动时不会
 * 因为鼠标移出元素而丢失跟随（用了 setPointerCapture）。
 */
import { useCallback, useRef, useState } from 'react';
import { MOCAP_LIMITS } from '@/lib/mocap/mocap-types';

interface Props {
  /** 录制总时长（毫秒） */
  durationMs: number;
  inMs: number;
  outMs: number;
  onChange: (inMs: number, outMs: number) => void;
  /** 烘焙后的帧数/时长，用于即时反馈 */
  outputFrames?: number;
  outputDuration?: number;
  disabled?: boolean;
}

type Handle = 'in' | 'out' | 'range';

export default function ClipTrimmer({
  durationMs,
  inMs,
  outMs,
  onChange,
  outputFrames,
  outputDuration,
  disabled,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: Handle; startX: number; startIn: number; startOut: number } | null>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);

  const total = Math.max(1, durationMs);
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / total) * 100))}%`;
  const selectionMs = outMs - inMs;

  const posFromEvent = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      return Math.max(0, Math.min(1, ratio)) * total;
    },
    [total],
  );

  const onPointerDown = (kind: Handle) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind, startX: e.clientX, startIn: inMs, startOut: outMs };
    setDragging(kind);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || disabled) return;
    const min = MOCAP_LIMITS.minTrimMs;
    const at = posFromEvent(e.clientX);

    if (drag.kind === 'in') {
      // 入点不能越过「出点 − 最短区间」
      onChange(Math.max(0, Math.min(at, drag.startOut - min)), drag.startOut);
      return;
    }
    if (drag.kind === 'out') {
      onChange(drag.startIn, Math.min(total, Math.max(at, drag.startIn + min)));
      return;
    }
    // 整体平移：保持区间长度，撞到边界就停
    const deltaMs = ((e.clientX - drag.startX) / (trackRef.current?.getBoundingClientRect().width || 1)) * total;
    const len = drag.startOut - drag.startIn;
    const nextIn = Math.max(0, Math.min(total - len, drag.startIn + deltaMs));
    onChange(nextIn, nextIn + len);
  };

  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    setDragging(null);
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const nudge = (kind: 'in' | 'out', deltaMs: number) => () => {
    if (disabled) return;
    const min = MOCAP_LIMITS.minTrimMs;
    if (kind === 'in') onChange(Math.max(0, Math.min(inMs + deltaMs, outMs - min)), outMs);
    else onChange(inMs, Math.min(total, Math.max(outMs + deltaMs, inMs + min)));
  };

  return (
    <div className={`trimmer${disabled ? ' is-disabled' : ''}`}>
      <div className="trimmer-head">
        <span>
          选区 <strong>{(selectionMs / 1000).toFixed(2)}s</strong>
          <span className="trimmer-hint"> 最短 {(MOCAP_LIMITS.minTrimMs / 1000).toFixed(2)}s</span>
        </span>
        <span>
          入 {(inMs / 1000).toFixed(2)}s · 出 {(outMs / 1000).toFixed(2)}s · 录制总长{' '}
          {(durationMs / 1000).toFixed(2)}s
        </span>
        <span>
          {typeof outputFrames === 'number' && typeof outputDuration === 'number'
            ? `→ ${outputFrames} 帧 / ${outputDuration.toFixed(2)}s @30fps`
            : ''}
        </span>
      </div>

      <div
        ref={trackRef}
        className={`trimmer-track${dragging ? ' is-dragging' : ''}`}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(e) => dragging && endDrag(e)}
      >
        <div
          className="trimmer-selection"
          style={{ left: pct(inMs), width: pct(selectionMs) }}
          onPointerDown={onPointerDown('range')}
          title="拖动整体平移选区"
        />
        <div
          className="trimmer-handle trimmer-handle-in"
          style={{ left: pct(inMs) }}
          onPointerDown={onPointerDown('in')}
          title="拖动设置入点"
        />
        <div
          className="trimmer-handle trimmer-handle-out"
          style={{ left: pct(outMs) }}
          onPointerDown={onPointerDown('out')}
          title="拖动设置出点"
        />
      </div>

      <div className="trimmer-nudges">
        <button type="button" onClick={nudge('in', -100)} disabled={disabled}>
          入点 −0.1s
        </button>
        <button type="button" onClick={nudge('in', 100)} disabled={disabled}>
          入点 +0.1s
        </button>
        <button type="button" onClick={nudge('out', -100)} disabled={disabled}>
          出点 −0.1s
        </button>
        <button type="button" onClick={nudge('out', 100)} disabled={disabled}>
          出点 +0.1s
        </button>
        <button
          type="button"
          onClick={() => onChange(0, total)}
          disabled={disabled || total < MOCAP_LIMITS.minTrimMs}
        >
          全选
        </button>
      </div>
    </div>
  );
}

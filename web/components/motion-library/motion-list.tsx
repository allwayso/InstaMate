'use client';

/**
 * 动作库列表。
 *
 * 刻意**不做删除与重命名**：动作库是团队共享资产，误删一次就要重录，
 * 而重录需要人和摄像头同时在场。UI 上明确标注"本版不支持删除"，避免有人找不到入口时
 * 以为是自己眼瞎，转而去翻文件系统手删。
 *
 * 元数据分两类：
 *   · 动作本身的（时长/帧率/帧数/骨骼/来源）来自 clip 与目录条目
 *   · 录制的（跟踪有效率/创建时间/原始关键点）来自 MocapCaptureV1，
 *     在目录条目里以可选字段出现 —— 导入的动作没有这些，显示为"—"而不是 0，
 *     因为 0% 有效率是一个有意义的值，和"没有这个信息"必须能区分。
 */
import { useMemo, useRef, useState } from 'react';
import type { ClipCatalogEntry } from '@/lib/clip-catalog';

interface Props {
  entries: ClipCatalogEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
  onDownloadClip: (id: string) => void;
  onDownloadLandmarks: (id: string) => void;
  onImport: (file: File) => void;
  /** 正在播放的动作 id（高亮用） */
  playingId?: string | null;
  busy?: boolean;
  /** 是否本机存在原始关键点（data/mocap 不进 git，新克隆后会缺） */
  landmarksAvailable: (id: string) => boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  generated: '程序化',
  mocap: '动捕',
  imported: '导入',
};

function fmtDuration(sec: number | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '—';
  return `${sec.toFixed(2)}s`;
}

function fmtPercent(v: number | undefined): string {
  // 注意：0% 是合法值（整段都没跟踪上），与"没有这个信息"必须区分开
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function MotionList({
  entries,
  selectedId,
  onSelect,
  onPlay,
  onDownloadClip,
  onDownloadLandmarks,
  onImport,
  playingId,
  busy,
  landmarksAvailable,
}: Props) {
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        (SOURCE_LABEL[e.source] ?? '').includes(q),
    );
  }, [entries, query]);

  const mocapCount = entries.filter((e) => e.source === 'mocap').length;

  return (
    <div className="motion-list">
      <div className="motion-list-head">
        <input
          type="search"
          placeholder="搜索显示名 / ID / 来源"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索动作"
        />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = ''; // 允许连续导入同一个文件
          }}
        />
      </div>

      <p className="motion-list-note">
        共 {entries.length} 个（动捕 {mocapCount}）｜
        <strong>本版不支持删除与重命名</strong>，避免误删团队资产；要清理请手动改
        <code>web/public/clips/</code>
      </p>

      <div className="motion-list-scroll">
        <table className="motion-table">
          <thead>
            <tr>
              <th>显示名</th>
              <th>ID</th>
              <th>来源</th>
              <th>时长</th>
              <th>帧率</th>
              <th>帧数</th>
              <th>骨骼</th>
              <th>创建时间</th>
              <th>有效率</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr
                key={e.id}
                className={`${selectedId === e.id ? 'is-selected' : ''} ${playingId === e.id ? 'is-playing' : ''}`}
                onClick={() => onSelect(e.id)}
              >
                <td title={e.note}>{e.name}</td>
                <td className="mono">{e.id}</td>
                <td>{SOURCE_LABEL[e.source] ?? e.source}</td>
                <td>{fmtDuration(e.duration)}</td>
                <td>{e.fps ?? '—'}</td>
                <td>{e.frameCount ?? '—'}</td>
                <td className="mono small" title={(e.mask ?? []).join(', ')}>
                  {(e.mask ?? []).length}
                </td>
                <td className="small">{fmtDate(e.createdAt)}</td>
                <td>{fmtPercent(e.trackingValidRatio)}</td>
                <td className="motion-actions">
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onPlay(e.id);
                    }}
                  >
                    播放
                  </button>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onDownloadClip(e.id);
                    }}
                  >
                    clip
                  </button>
                  <button
                    type="button"
                    disabled={!landmarksAvailable(e.id)}
                    title={
                      landmarksAvailable(e.id)
                        ? '下载原始关键点'
                        : '本机没有这个动作的原始关键点（data/mocap/ 不进 git）'
                    }
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onDownloadLandmarks(e.id);
                    }}
                  >
                    原始点
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="motion-empty">
                  {entries.length === 0 ? '动作目录为空' : '没有匹配的动作'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

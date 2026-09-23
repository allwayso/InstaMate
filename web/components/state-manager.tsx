'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ClipCatalogEntry } from '@/lib/clip-catalog';
import { getActiveState, onStateChange, stopState, triggerState, type ActiveState } from '@/lib/state-events';
import type { StateEntry } from '@/lib/states-store';

const EMOTIONS = ['neutral', 'happy', 'excited', 'shy', 'angry', 'sad', 'surprised'];
const EMOTION_LABEL: Record<string, string> = { neutral: '平静', happy: '开心', excited: '兴奋', shy: '害羞', angry: '生气', sad: '难过', surprised: '惊讶' };

export default function StateManager() {
  const [states, setStates] = useState<StateEntry[]>([]);
  const [clips, setClips] = useState<ClipCatalogEntry[]>([]);
  const [active, setActive] = useState<ActiveState | null>(null);
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [emotion, setEmotion] = useState('neutral');
  const [duration, setDuration] = useState('');
  const [loop, setLoop] = useState(false);
  const [clipId, setClipId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    const response = await fetch('/api/states', { cache: 'no-store' });
    const data = await response.json() as { states?: StateEntry[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? '状态库读取失败');
    setStates(data.states ?? []);
  }

  useEffect(() => {
    const unsubscribe = onStateChange(setActive);
    setActive(getActiveState());
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    void fetch('/clips/index.json').then((response) => response.json())
      .then((data: { clips?: ClipCatalogEntry[] }) => setClips(data.clips ?? []))
      .catch(() => setClips([]));
    return unsubscribe;
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.set('name', name.trim());
      body.set('trigger_words', words);
      body.set('emotion', emotion);
      body.set('duration', duration);
      body.set('loop', String(loop));
      body.set('clip_id', clipId);
      if (file) body.set('file', file);
      const response = await fetch('/api/states', { method: 'POST', body });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? '状态保存失败');
      setName(''); setWords(''); setEmotion('neutral'); setDuration('');
      setLoop(false); setClipId(''); setFile(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError('');
    const response = await fetch(`/api/states/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      setError(data.error ?? '删除失败');
      return;
    }
    if (active?.id === id) stopState();
    await refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  return (
    <section className="states-panel" aria-label="状态库">
      <div className="states-head">
        <div>
          <h2>角色状态库</h2>
          <p>将对话意图关联到现有动作；也可保存 GLB 或录像素材，供后续重定向。</p>
        </div>
        <div className="states-active" role="status">
          {active ? `表演中：${active.name}` : '角色待命'}
          {active?.loop && <button type="button" onClick={stopState}>停止</button>}
        </div>
      </div>
      {error && <p className="states-error" role="alert">{error}</p>}
      <div className="states-grid">
        <div>
          <h3>已保存状态（{states.length}）</h3>
          {states.length === 0 && <p className="states-muted">暂无状态，添加后可由聊天触发。</p>}
          <ul className="states-list">
            {states.map((state) => (
              <li key={state.id}>
                <div className="states-item-copy">
                  <strong>{state.name}</strong>
                  <span>
                    {EMOTION_LABEL[state.emotion] ?? state.emotion} · {state.clip_id ? `动作：${state.clip_id}` : '未绑定动作'}
                    {state.loop ? ' · 循环' : ''}
                    {state.trigger_words.length ? ` · ${state.trigger_words.join('、')}` : ''}
                  </span>
                  {state.file && <a href={`/api/states/${encodeURIComponent(state.id)}/file`}>下载{state.file_type === 'glb' ? ' GLB' : '录像'}素材</a>}
                </div>
                <div className="states-item-actions">
                  <button type="button" onClick={() => triggerState({
                    id: state.id, name: state.name, duration: state.duration, loop: state.loop,
                    clipId: state.clip_id, emotion: state.emotion,
                  }, 'manual')}>触发</button>
                  <button type="button" onClick={() => void remove(state.id)} aria-label={`删除 ${state.name}`}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <form className="states-form" onSubmit={save}>
          <h3>新增状态</h3>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder="挥手打招呼" /></label>
          <label>触发词<input value={words} onChange={(event) => setWords(event.target.value)} placeholder="你好, hi, 挥手" /></label>
          <div className="states-form-row">
            <label>情绪<select value={emotion} onChange={(event) => setEmotion(event.target.value)}>
              {EMOTIONS.map((option) => <option key={option} value={option}>{EMOTION_LABEL[option]}</option>)}
            </select></label>
            <label>时长（秒）<input type="number" min="0" max="600" step="0.5" value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="自动" /></label>
          </div>
          <label>播放动作<select value={clipId} onChange={(event) => setClipId(event.target.value)}>
            <option value="">暂不绑定</option>
            {clips.map((clip) => <option key={clip.id} value={clip.id}>{clip.name}（{clip.id}）</option>)}
          </select></label>
          <label className="states-check"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />循环播放</label>
          <label>附加素材（可选）<input type="file" accept=".glb,.mp4,.webm,.mov" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <p className="states-muted">GLB 和录像会保存在本机。要让角色立即做动作，请选择上方动作库 clip。</p>
          <button type="submit" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存到状态库'}</button>
        </form>
      </div>
    </section>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PROFILE_CHANGE_EVENT,
  PROFILE_STORAGE_KEY,
} from '@/lib/profile-selection';

/**
 * 「智能体实际加载了什么」面板。
 *
 * 为什么必须有这个：
 *
 * 改动之后，对话用的**不是**原始档案 JSON，而是分析阶段生成好的
 * `system_prompt.md` / `memory.md`。如果界面里看不到它们，
 * 用户就只能靠"聊天感觉"判断人设有没有生效 —— 那比改动前更糟
 * （改动前至少能打开 profile JSON 看一眼）。
 *
 * 所以这个面板同时回答三个问题：
 *   ① 现在生效的是谁的提示词   → 顶上标出"当前对话使用"
 *   ② 到底长什么样             → 全文展示，不截断
 *   ③ 文件在哪                 → 显示本地路径，方便直接用编辑器改
 */

interface AgentSummary {
  agent_id: string;
  target_speaker: string;
  source: string;
  system_prompt_chars: number;
  memory_items: number;
}

interface AgentDetail extends AgentSummary {
  generated_at: string;
  model_name: string;
  directory: string;
  system_prompt: string;
  memory: string;
}

const DEFAULT_ID = 'default';

export default function AgentInspector() {
  const [list, setList] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState(DEFAULT_ID);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [active, setActive] = useState(DEFAULT_ID);
  const [tab, setTab] = useState<'prompt' | 'memory'>('prompt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadList = useCallback(async () => {
    try {
      const response = await fetch('/api/agents', { cache: 'no-store' });
      const data = (await response.json()) as {
        default?: AgentSummary;
        profiles?: AgentSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? '无法读取智能体列表');
      setList([...(data.default ? [data.default] : []), ...(data.profiles ?? [])]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadDetail = useCallback(async (agentId: string) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/agents/' + agentId, { cache: 'no-store' });
      const data = (await response.json()) as AgentDetail & { error?: string };
      if (!response.ok) throw new Error(data.error ?? '无法读取该档案的智能体文件');
      setDetail(data);
      setTab('prompt');
    } catch (cause) {
      setDetail(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
    // 当前生效的档案存在 localStorage 里；聊天面板改它时会派发事件
    const read = () => setActive(localStorage.getItem(PROFILE_STORAGE_KEY) || DEFAULT_ID);
    read();
    window.addEventListener(PROFILE_CHANGE_EVENT, read);
    return () => window.removeEventListener(PROFILE_CHANGE_EVENT, read);
  }, [loadList]);

  useEffect(() => {
    void loadDetail(selected);
  }, [selected, loadDetail]);

  async function regenerate() {
    if (!detail || detail.agent_id === DEFAULT_ID) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/agents/' + detail.agent_id, { method: 'POST' });
      const data = (await response.json()) as AgentDetail & { error?: string };
      if (!response.ok) throw new Error(data.error ?? '重新生成失败');
      setDetail(data);
      void loadList();
      setNotice('已按最新的档案内容重新渲染。原始分析结果没有改动。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const label = (item: AgentSummary) =>
    item.agent_id === DEFAULT_ID ? '默认影伴' : item.target_speaker || item.agent_id.slice(0, 8);

  return (
    <section className="profile-panel agent-inspector">
      <h2>智能体实际加载的内容</h2>
      <p>
        对话时交给模型的<strong>不是</strong>原始档案，而是分析阶段生成好的两个文件。
        这里是它们的原文 —— 想改人设可以直接编辑磁盘上的文件，下一句话就会生效。
      </p>

      <div className="profile-actions">
        <label>
          查看
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            {list.map((item) => (
              <option key={item.agent_id} value={item.agent_id}>
                {label(item)}
                {item.agent_id === active ? '（当前对话使用）' : ''}
              </option>
            ))}
          </select>
        </label>
        {detail && detail.agent_id !== DEFAULT_ID && (
          <button type="button" disabled={busy} onClick={() => void regenerate()}>
            按最新档案重新生成
          </button>
        )}
      </div>

      {notice && <p className="profile-status" role="status">{notice}</p>}
      {error && <p className="profile-error" role="alert">{error}</p>}

      {detail && (
        <div className="profile-result">
          <div className="agent-meta">
            <span>
              {detail.agent_id === active ? '★ 当前对话使用' : '（未选中，仅供查看）'}
            </span>
            <span>系统提示词 {detail.system_prompt_chars} 字</span>
            <span>长期记忆 {detail.memory_items} 条</span>
            {detail.model_name && <span>由 {detail.model_name} 生成</span>}
            {detail.generated_at && <span>{detail.generated_at.slice(0, 19).replace('T', ' ')}</span>}
          </div>

          <div className="agent-tabs" role="tablist">
            <button
              type="button" role="tab" aria-selected={tab === 'prompt'}
              className={tab === 'prompt' ? 'is-current' : ''}
              onClick={() => setTab('prompt')}
            >
              系统提示词
            </button>
            <button
              type="button" role="tab" aria-selected={tab === 'memory'}
              className={tab === 'memory' ? 'is-current' : ''}
              onClick={() => setTab('memory')}
            >
              memory 文件
            </button>
          </div>

          <pre className="agent-text" data-tab={tab}>
            {tab === 'prompt'
              ? detail.system_prompt
              : detail.memory.trim() || '（这份档案没有可复用的长期事实）'}
          </pre>

          <p className="agent-path">
            文件位置：<code>{detail.directory}</code>
            <br />
            改完这两个 .md 文件后<strong>不需要重启服务</strong> —— 下一次对话就会读新的。
          </p>
        </div>
      )}
    </section>
  );
}

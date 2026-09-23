'use client';

import { useEffect, useState } from 'react';

type TripoStatus = {
  configured: boolean;
  keySource: 'local-file' | 'environment' | 'missing';
  baseUrl: string;
};

export default function TripoSettings({ onConfigured }: { onConfigured: (ready: boolean) => void }) {
  const [status, setStatus] = useState<TripoStatus | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/tripo-settings', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json() as TripoStatus & { error?: string };
        if (!response.ok) throw new Error(data.error ?? '无法读取配置');
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setStatus(data);
        setBaseUrl(data.baseUrl);
        setExpanded(!data.configured);
        onConfigured(data.configured);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '无法读取配置'); });
    return () => { cancelled = true; };
  }, [onConfigured]);

  async function save() {
    if (busy) return;
    setBusy('save'); setError(''); setMessage('');
    try {
      const response = await fetch('/api/tripo-settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, baseUrl }),
      });
      const data = await response.json() as TripoStatus & { error?: string };
      if (!response.ok) throw new Error(data.error ?? '保存失败');
      setStatus(data);
      setBaseUrl(data.baseUrl);
      setKey('');
      setMessage('已保存在本机；新建模型任务会立即使用此配置。');
      onConfigured(data.configured);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally { setBusy(''); }
  }

  async function testConnection() {
    if (busy) return;
    setBusy('test'); setError(''); setMessage('');
    try {
      const response = await fetch('/api/tripo-settings/test', { method: 'POST' });
      const data = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? '连接失败');
      setMessage(data.message ?? '连接成功');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接失败');
    } finally { setBusy(''); }
  }

  return (
    <section className="tripo-settings" aria-label="Tripo 服务设置">
      <button className="tripo-settings-toggle" type="button" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span><strong>Tripo 服务设置</strong><small>模型生成所需的 API Key 与服务地址</small></span>
        <span className={status?.configured ? 'tripo-status is-ready' : 'tripo-status'}>
          {status === null ? '正在检查' : status.configured ? '已配置' : '需要配置'}
        </span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && <div className="tripo-settings-body">
        <div className="tripo-settings-grid">
          <label>API Key
            <input type="password" value={key} onChange={(event) => setKey(event.target.value)}
              autoComplete="new-password" spellCheck={false}
              placeholder={status?.configured ? '已保存，留空可保持现有密钥' : '填写 Tripo API Key'} />
          </label>
          <label>API 地址
            <input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false} placeholder="https://api.tripo3d.com/v2/openapi" />
          </label>
        </div>
        <p className="tripo-settings-note">通过此面板保存的密钥会写入本机忽略 Git 的 tripo/.env；页面不会回显密钥。修改地址后先保存，再测试连接。</p>
        <div className="tripo-settings-actions">
          <button type="button" className="primary" disabled={Boolean(busy) || !baseUrl.trim()}
            onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存配置'}</button>
          <button type="button" disabled={Boolean(busy) || !status?.configured}
            onClick={() => void testConnection()}>{busy === 'test' ? '检测中…' : '测试连接'}</button>
          {status?.keySource === 'environment' && <span>当前密钥来自环境变量；在此保存新密钥可覆盖它。</span>}
        </div>
        <div aria-live="polite">
          {message && <p className="tripo-settings-message">{message}</p>}
          {error && <p className="profile-error" role="alert">{error}</p>}
        </div>
      </div>}
    </section>
  );
}

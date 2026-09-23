'use client';

import { useEffect, useState } from 'react';
import type { ImageModel, ImageProvider } from '@/lib/aliyun-image-settings';

type ImageStatus = {
  configured: boolean;
  keySource: 'local-file' | 'environment' | 'legacy-tripo' | 'missing';
  baseUrl: string;
  provider: ImageProvider;
  model: ImageModel;
};

const MODELS: Record<ImageProvider, { id: ImageModel; label: string }[]> = {
  qwen: [
    { id: 'qwen-image-3.0', label: '千问 Image 3.0' },
    { id: 'qwen-image-3.0-pro', label: '千问 Image 3.0 Pro（更重视五官还原）' },
  ],
  wanx: [{ id: 'wan2.7-image-pro', label: '万相 2.7 Pro（更鲜明的动漫风格）' }],
};

export default function AliyunImageSettings({ onConfigured }: { onConfigured: (ready: boolean) => void }) {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [provider, setProvider] = useState<ImageProvider>('qwen');
  const [model, setModel] = useState<ImageModel>('qwen-image-3.0');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/aliyun-image-settings', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json() as ImageStatus & { error?: string };
        if (!response.ok) throw new Error(data.error ?? '无法读取百炼设置');
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setStatus(data);
        setBaseUrl(data.baseUrl);
        setProvider(data.provider);
        setModel(data.model);
        setExpanded(!data.configured || data.keySource === 'legacy-tripo');
        onConfigured(data.configured);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '无法读取百炼设置'); });
    return () => { cancelled = true; };
  }, [onConfigured]);

  async function save() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/aliyun-image-settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, baseUrl, provider, model }),
      });
      const data = await response.json() as ImageStatus & { error?: string };
      if (!response.ok) throw new Error(data.error ?? '保存失败');
      setStatus(data);
      setBaseUrl(data.baseUrl);
      setKey('');
      setMessage('百炼图片设置已保存在本机。');
      onConfigured(data.configured);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally { setBusy(false); }
  }

  return (
    <section className="tripo-settings" aria-label="阿里百炼图片动漫化设置">
      <button className="tripo-settings-toggle" type="button" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span><strong>阿里百炼 · 图片动漫化</strong><small>千问 Image 3.0 / 万相 2.7 · 使用人物照片生成动漫参考图</small></span>
        <span className={status?.configured ? 'tripo-status is-ready' : 'tripo-status'}>
          {status === null ? '正在检查' : status.configured ? '已配置' : '需要配置'}
        </span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && <div className="tripo-settings-body">
        {status?.keySource === 'legacy-tripo' &&
          <p className="banner warn">检测到百炼密钥误存于旧的 Tripo 设置。图片阶段现在可以使用它；请点击“保存百炼配置”迁移到独立设置。</p>}
        <div className="tripo-settings-grid">
          <label>图片服务
            <select value={provider} onChange={(event) => {
              const next = event.target.value as ImageProvider;
              setProvider(next);
              setModel(MODELS[next][0].id);
            }}>
              <option value="qwen">千问 Qwen-Image</option>
              <option value="wanx">通义万相</option>
            </select>
          </label>
          <label>模型
            <select value={model} onChange={(event) => setModel(event.target.value as ImageModel)}>
              {MODELS[provider].map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>百炼 API Key
            <input type="password" value={key} onChange={(event) => setKey(event.target.value)}
              autoComplete="new-password" spellCheck={false}
              placeholder={status?.configured ? '已保存，留空可保持现有密钥' : '填写阿里百炼 API Key'} />
          </label>
          <label>百炼兼容接口地址
            <input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false}
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
          </label>
        </div>
        <p className="tripo-settings-note">百炼密钥只保存在本机忽略 Git 的设置文件中；万相调用会自动使用同一业务空间的原生接口。此处不能填写 Tripo 地址。</p>
        <div className="tripo-settings-actions">
          <button type="button" className="primary" disabled={busy || !baseUrl.trim()} onClick={() => void save()}>
            {busy ? '保存中…' : '保存百炼配置'}
          </button>
          {status?.keySource === 'environment' && <span>当前密钥来自服务器环境变量。</span>}
        </div>
        <div aria-live="polite">
          {message && <p className="tripo-settings-message">{message}</p>}
          {error && <p className="profile-error" role="alert">{error}</p>}
        </div>
      </div>}
    </section>
  );
}

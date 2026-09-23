'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AvatarJob } from '@/lib/avatar-jobs';
import TripoSettings from '@/components/tripo-settings';

export default function AvatarCreator() {
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [name, setName] = useState('');
  const [style, setStyle] = useState<AvatarJob['style']>('anime');
  const [jobs, setJobs] = useState<AvatarJob[]>([]);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tripoReady, setTripoReady] = useState(false);

  useEffect(() => {
    if (!image) { setImagePreview(''); return; }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    void fetch('/api/avatar-jobs').then((response) => response.json())
      .then((data: { jobs?: AvatarJob[] }) => setJobs(data.jobs ?? []))
      .catch(() => setJobs([]));
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/avatar-jobs/' + activeId, { cache: 'no-store' });
        const job = await response.json() as AvatarJob;
        if (cancelled || !response.ok) return;
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        if (job.status === 'complete' || job.status === 'failed') setActiveId('');
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeId]);

  async function create() {
    if (!image || !name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.set('image', image);
      form.set('name', name.trim());
      form.set('style', style);
      const response = await fetch('/api/avatar-jobs', { method: 'POST', body: form });
      const data = await response.json() as AvatarJob & { error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? '模型任务创建失败');
      setJobs((current) => [data, ...current]);
      setActiveId(data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="avatar-creator">
      <h2>照片生成动漫角色</h2>
      <p>照片会先转换为动漫形象，再生成可展示的 3D 角色并保存在本机。提交后可在下方查看进度。</p>
      <TripoSettings onConfigured={setTripoReady} />
      <div className="avatar-creator-form">
        <label className="upload-field"><strong>上传一张人物照片</strong><small>JPG 或 PNG · 清晰的人物照片效果更好</small>
          {imagePreview && <img className="upload-preview" src={imagePreview} alt="待生成角色的人物照片" />}
          <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png"
          onChange={(event) => setImage(event.target.files?.[0] ?? null)} /></label>
        <label>角色名称<input value={name} onChange={(event) => setName(event.target.value)}
          maxLength={80} placeholder="给角色起个名字" /></label>
        <label>动漫风格<select value={style} onChange={(event) => setStyle(event.target.value as AvatarJob['style'])}>
          <option value="anime">日漫角色</option>
          <option value="soft">柔和手绘</option>
          <option value="chibi">Q 版动漫</option>
        </select></label>
        <button type="button" disabled={!tripoReady || !image || !name.trim() || busy} onClick={() => void create()}>
          {busy ? '正在提交…' : '开始生成模型'}
        </button>
      </div>
      {error && <p className="profile-error" role="alert">{error}</p>}
      <div className="section-heading"><h2>生成记录</h2><span className="section-note">角色会保存在这台设备上</span></div>
      {!jobs.length && <p className="empty-state">你的第一个影伴，将从这里诞生。选择照片后开始创建。</p>}
      <div className="avatar-jobs">
        {jobs.map((job) => (
          <article key={job.id}>
            <div><strong>{job.name}</strong><span>{job.stage} · {{ queued: '等待中', running: '生成中', complete: '已完成', failed: '生成失败' }[job.status]}</span></div>
            {job.preview_url && <img src={job.preview_url} alt={job.name + ' 的动漫 T-pose 参考图'} />}
            {job.error && <p className="profile-error">{job.error}</p>}
            {job.avatar_url && <Link href={'/?avatar=' + encodeURIComponent(job.avatar_url)}>
              打开这个 3D 角色
            </Link>}
          </article>
        ))}
      </div>
    </section>
  );
}

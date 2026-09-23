'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AvatarJob } from '@/lib/avatar-jobs';

export default function AvatarCreator() {
  const [image, setImage] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [style, setStyle] = useState<AvatarJob['style']>('anime');
  const [jobs, setJobs] = useState<AvatarJob[]>([]);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      <p>上传照片后依次生成动漫 T-pose 参考图、Tripo 3D 模型、绑骨 GLB 与本地 VRM。生成过程会在后台继续运行。</p>
      <div className="avatar-creator-form">
        <label>人物照片<input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png"
          onChange={(event) => setImage(event.target.files?.[0] ?? null)} /></label>
        <label>角色名称<input value={name} onChange={(event) => setName(event.target.value)}
          maxLength={80} placeholder="给角色起个名字" /></label>
        <label>动漫风格<select value={style} onChange={(event) => setStyle(event.target.value as AvatarJob['style'])}>
          <option value="anime">日漫角色</option>
          <option value="soft">柔和手绘</option>
          <option value="chibi">Q 版动漫</option>
        </select></label>
        <button type="button" disabled={!image || !name.trim() || busy} onClick={() => void create()}>
          {busy ? '正在提交…' : '开始生成模型'}
        </button>
      </div>
      {error && <p className="profile-error" role="alert">{error}</p>}
      <h3>本地任务</h3>
      {!jobs.length && <p className="states-muted">尚无生成任务。</p>}
      <div className="avatar-jobs">
        {jobs.map((job) => (
          <article key={job.id}>
            <div><strong>{job.name}</strong><span>{job.stage} · {job.status}</span></div>
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

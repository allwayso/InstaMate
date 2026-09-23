'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { AvatarJob } from '@/lib/avatar-jobs';
import TripoSettings from '@/components/tripo-settings';

/**
 * 照片 → 角色。
 *
 * 流程刻意断成两段：
 *
 *   第一段（5 积分）  背景清洗 + T-pose 平面图  →  **停下来给用户看**
 *   第二段（85 积分） 建模 40 + 贴图 20 + 绑骨 25 →  用户点了「继续生成」才跑
 *
 * 为什么值得多这一步确认：只有人能看出"背景洗得对不对、是不是还是同一个人"，
 * 而第一段只花 5 积分、后面要花 85 —— 把判断放在便宜的阶段之后、昂贵的阶段之前。
 */
export default function TripoAvatarCreator() {
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [name, setName] = useState('');
  const [style, setStyle] = useState<AvatarJob['style']>('anime');
  const [jobs, setJobs] = useState<AvatarJob[]>([]);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [tripoReady, setTripoReady] = useState(false);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceForRef = useRef('');

  useEffect(() => {
    if (!image) { setImagePreview(''); return; }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    void fetch('/api/avatar-jobs').then((response) => response.json())
      .then((data: { jobs?: AvatarJob[] }) => setJobs((data.jobs ?? []).filter((job) => job.generation_mode === 'tripo' || (!job.generation_mode && !job.image_provider))))
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
        // 注意 awaiting_continue 要**继续轮询之外的处理**：它是终态（第一段结束），
        // 不停的话会一直打接口；但也不能当成"完成"，因为球在用户手上。
        if (job.status === 'complete' || job.status === 'failed'
          || job.status === 'cancelled' || job.status === 'awaiting_continue') {
          setActiveId('');
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeId]);

  function upsert(job: AvatarJob) {
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
  }

  async function create() {
    if (!image || !name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.set('image', image);
      form.set('name', name.trim());
      form.set('style', style);
      form.set('generation_mode', 'tripo');
      const response = await fetch('/api/avatar-jobs', { method: 'POST', body: form });
      const data = await response.json() as AvatarJob & { error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? '模型任务创建失败');
      upsert(data);
      setActiveId(data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, path: string, init: RequestInit, label: string) {
    setWorking(id + ':' + label); setError('');
    try {
      const response = await fetch(`/api/avatar-jobs/${id}${path}`, init);
      const data = await response.json() as AvatarJob & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `${label}失败`);
      if (data.id) upsert(data);
      if (label === '继续生成') setActiveId(id); // 第二段又要跑几分钟，恢复轮询
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  }

  const continueJob = (id: string) =>
    act(id, '/continue', { method: 'POST' }, '继续生成');
  const cancelJob = (id: string) =>
    act(id, '', { method: 'DELETE' }, '放弃');

  async function replaceImage(id: string, file: File) {
    const form = new FormData();
    form.set('image', file);
    await act(id, '/image', { method: 'PUT', body: form }, '换一张图');
    setActiveId(id);
  }

  const STATUS_LABEL: Record<AvatarJob['status'], string> = {
    queued: '等待中', running: '生成中', awaiting_continue: '等待你确认',
    'image-ready': '图片已完成', complete: '已完成', failed: '生成失败', cancelled: '已放弃',
  };

  return (
    <section className="avatar-creator">
      <h2>照片生成动漫角色</h2>
      <p>
        照片会先做一次背景清洗、生成 T-pose 平面图（5 积分），
        <strong>停下来给你确认</strong>；确认之后再建模、贴图与绑骨（约 85 积分）。
        也可以<Link href="/create">使用阿里百炼动漫化流程</Link>。
      </p>
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
          {busy ? '正在提交…' : '开始生成平面图'}
        </button>
      </div>
      {error && <p className="profile-error" role="alert">{error}</p>}

      {/* 换图用的隐藏输入：按钮只是触发器，选完立刻上传 */}
      <input ref={replaceRef} type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          const id = replaceForRef.current;
          event.target.value = '';
          if (file && id) void replaceImage(id, file);
        }} />

      <div className="section-heading"><h2>生成记录</h2><span className="section-note">角色会保存在这台设备上</span></div>
      {!jobs.length && <p className="empty-state">你的第一个影伴，将从这里诞生。选择照片后开始创建。</p>}
      <div className="avatar-jobs">
        {jobs.map((job) => (
          <article key={job.id} className={job.status === 'awaiting_continue' ? 'awaiting' : ''}>
            <div><strong>{job.name}</strong><span>{job.stage} · {STATUS_LABEL[job.status]}</span></div>
            {job.preview_url && <img src={job.preview_url} alt={job.name + ' 的背景清洗平面图'} />}
            {job.error && <p className="profile-error">{job.error}</p>}

            {job.status === 'awaiting_continue' && (
              <div className="avatar-confirm">
                <p>
                  这是背景清洗后的平面图 —— 后面所有步骤都会照着它做。
                  不满意就换一张，只重花 5 积分；确认继续才会花约 85 积分去建模、贴图、绑骨。
                </p>
                <div className="avatar-actions">
                  <button type="button" disabled={!!working} onClick={() => void continueJob(job.id)}>
                    {working === job.id + ':继续生成' ? '正在启动…' : '继续生成'}
                  </button>
                  <button type="button" className="ghost" disabled={!!working} onClick={() => {
                    replaceForRef.current = job.id;
                    replaceRef.current?.click();
                  }}>
                    {working === job.id + ':换一张图' ? '正在重新清洗…' : '换一张图'}
                  </button>
                  <button type="button" className="ghost danger" disabled={!!working}
                    onClick={() => void cancelJob(job.id)}>
                    {working === job.id + ':放弃' ? '正在放弃…' : '放弃'}
                  </button>
                </div>
              </div>
            )}

            {job.avatar_url && <Link href={'/?avatar=' + encodeURIComponent(job.avatar_url)}>
              打开这个 3D 角色
            </Link>}
          </article>
        ))}
      </div>
    </section>
  );
}

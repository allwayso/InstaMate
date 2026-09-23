'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { AvatarJob } from '@/lib/avatar-jobs';
import TripoSettings from '@/components/tripo-settings';
import AliyunImageSettings from '@/components/aliyun-image-settings';

type Workspace = 'image' | 'model';

function isPending(job: AvatarJob) {
  return job.status === 'queued' || job.status === 'running';
}

function mergeJobs(current: AvatarJob[], incoming: AvatarJob[], deleted: Set<string>) {
  const byId = new Map(current.filter((job) => !deleted.has(job.id)).map((job) => [job.id, job]));
  for (const job of incoming) {
    if (deleted.has(job.id)) continue;
    const previous = byId.get(job.id);
    if (!previous || job.updated_at >= previous.updated_at) byId.set(job.id, job);
  }
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function statusText(job: AvatarJob) {
  return {
    queued: '等待中', running: '生成中', 'image-ready': '图片已完成',
    complete: '3D 已完成', failed: '生成失败',
  }[job.status];
}

function createdLabel(job: AvatarJob) {
  const created = new Date(job.created_at);
  return Number.isNaN(created.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(created);
}

export default function AvatarCreator() {
  const [workspace, setWorkspace] = useState<Workspace>('image');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [name, setName] = useState('');
  const [style, setStyle] = useState<AvatarJob['style']>('anime');
  const [jobs, setJobs] = useState<AvatarJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tripoReady, setTripoReady] = useState(false);
  const [aliyunReady, setAliyunReady] = useState(false);
  const deletedIds = useRef(new Set<string>());

  const hasPendingJobs = jobs.some(isPending);
  const clearableJobs = jobs.filter((job) => !isPending(job));
  const referenceJobs = jobs.filter((job) => Boolean(job.preview_url));
  const selectedJob = referenceJobs.find((job) => job.id === selectedJobId) ?? referenceJobs[0];
  const modelJobs = jobs.filter((job) => job.avatar_url ||
    (job.preview_url && job.status !== 'image-ready'));

  useEffect(() => {
    if (!image) { setImagePreview(''); return; }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/avatar-jobs', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json() as { jobs?: AvatarJob[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? '无法读取生成记录');
        return data.jobs ?? [];
      })
      .then((incoming) => {
        if (!cancelled) setJobs((current) => mergeJobs(current, incoming, deletedIds.current));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法读取生成记录');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hasPendingJobs) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/avatar-jobs', { cache: 'no-store' });
        const data = await response.json() as { jobs?: AvatarJob[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? '无法更新任务状态');
        if (!cancelled) setJobs((current) => mergeJobs(current, data.jobs ?? [], deletedIds.current));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法更新任务状态');
      }
    };
    const timer = setInterval(() => void poll(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [hasPendingJobs]);

  async function create() {
    if (!aliyunReady || !image || !name.trim() || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const form = new FormData();
      form.set('image', image);
      form.set('name', name.trim());
      form.set('style', style);
      const response = await fetch('/api/avatar-jobs', { method: 'POST', body: form });
      const data = await response.json() as AvatarJob & { error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? '动漫图片任务创建失败');
      setJobs((current) => mergeJobs(current, [data], deletedIds.current));
      setNotice('图片任务已提交，完成后会出现在下方记录中。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function createModel(job: AvatarJob) {
    if (!tripoReady || busy ||
      !(job.status === 'image-ready' || (job.status === 'failed' && job.preview_url))) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/avatar-jobs/' + job.id + '/model', { method: 'POST' });
      const data = await response.json() as AvatarJob & { error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? '3D 建模任务启动失败');
      setJobs((current) => mergeJobs(current, [data], deletedIds.current));
      setNotice('3D 建模任务已启动，可在本模块查看进度。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function deleteRecord(id: string) {
    if (deleting) return;
    setDeleting(id); setError(''); setNotice('');
    try {
      const response = await fetch('/api/avatar-jobs/' + id, { method: 'DELETE' });
      const data = await response.json() as { deletedId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? '删除记录失败');
      deletedIds.current.add(data.deletedId ?? id);
      setJobs((current) => current.filter((job) => job.id !== id));
      setConfirmDeleteId('');
      setNotice('这条生成记录和关联的本地文件已清理。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setDeleting(''); }
  }

  async function clearFinishedRecords() {
    if (deleting || !clearableJobs.length) return;
    setDeleting('all'); setError(''); setNotice('');
    try {
      const response = await fetch('/api/avatar-jobs', { method: 'DELETE' });
      const data = await response.json() as { deletedIds?: string[]; skippedIds?: string[]; error?: string };
      if (!response.ok || !Array.isArray(data.deletedIds)) throw new Error(data.error ?? '清理生成记录失败');
      for (const id of data.deletedIds) deletedIds.current.add(id);
      const removed = new Set(data.deletedIds);
      setJobs((current) => current.filter((job) => !removed.has(job.id)));
      setConfirmClearAll(false);
      const skipped = data.skippedIds?.length ?? 0;
      setNotice('已清理 ' + data.deletedIds.length + ' 条记录；' +
        (skipped ? '另有 ' + skipped + ' 条正在生成或暂时不可清理。' : '正在生成的任务已保留。'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setDeleting(''); }
  }

  function switchWorkspace(next: Workspace, jobId = '') {
    setWorkspace(next);
    if (jobId) setSelectedJobId(jobId);
    setConfirmDeleteId('');
    setConfirmClearAll(false);
    setError('');
    setNotice('');
  }

  function handleWorkspaceKey(event: KeyboardEvent<HTMLButtonElement>) {
    let next: Workspace | null = null;
    if (event.key === 'Home') next = 'image';
    else if (event.key === 'End') next = 'model';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = workspace === 'image' ? 'model' : 'image';
    }
    if (!next) return;
    event.preventDefault();
    switchWorkspace(next);
    document.getElementById(next === 'image' ? 'avatar-image-tab' : 'avatar-model-tab')?.focus();
  }

  return (
    <section className="avatar-creator">
      <div className="avatar-workflow-nav" role="tablist" aria-label="创建角色工作模块">
        <button type="button" role="tab" id="avatar-image-tab" aria-selected={workspace === 'image'}
          aria-controls="avatar-image-panel" tabIndex={workspace === 'image' ? 0 : -1}
          onKeyDown={handleWorkspaceKey} onClick={() => switchWorkspace('image')}>
          <span className="avatar-workflow-number">01</span>
          <span><strong>图片动漫化</strong><small>人物照片 → 动漫 T-pose</small></span>
        </button>
        <button type="button" role="tab" id="avatar-model-tab" aria-selected={workspace === 'model'}
          aria-controls="avatar-model-panel" tabIndex={workspace === 'model' ? 0 : -1}
          onKeyDown={handleWorkspaceKey} onClick={() => switchWorkspace('model')}>
          <span className="avatar-workflow-number">02</span>
          <span><strong>3D 建模</strong><small>确认参考图 → 可动的 3D 角色</small></span>
        </button>
      </div>

      <div id="avatar-image-panel" role="tabpanel" aria-labelledby="avatar-image-tab"
        className="avatar-workflow-pane" hidden={workspace !== 'image'}>
          <h2>照片生成动漫角色</h2>
          <p className="avatar-pane-intro">使用阿里百炼将人物照片转换为动漫 T-pose 参考图。图片满意后，可到顶部的「3D 建模」模块继续。</p>
          <AliyunImageSettings onConfigured={setAliyunReady} />
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
            <button type="button" disabled={!aliyunReady || !image || !name.trim() || busy}
              onClick={() => void create()}>{busy ? '正在提交…' : '生成动漫参考图'}</button>
          </div>
          {error && <p className="profile-error" role="alert">{error}</p>}
          {notice && <p className="avatar-notice" role="status">{notice}</p>}
          <div className="section-heading avatar-record-heading">
            <div><h2>生成记录</h2><p>原图与生成结果保存在这台设备上 · 共 {jobs.length} 条</p></div>
            <button type="button" className="quiet-button" disabled={!clearableJobs.length || Boolean(deleting)}
              onClick={() => setConfirmClearAll(true)}>清理已结束记录</button>
          </div>
          {confirmClearAll && <div className="avatar-cleanup-confirm" role="group" aria-label="确认清理生成记录">
            <p>将删除 {clearableJobs.length} 条已结束记录及其原图、动漫图和已生成的 VRM 文件；正在生成的任务会保留。</p>
            <button type="button" className="danger" disabled={Boolean(deleting)}
              onClick={() => void clearFinishedRecords()}>{deleting === 'all' ? '清理中…' : '确认清理'}</button>
            <button type="button" disabled={Boolean(deleting)} onClick={() => setConfirmClearAll(false)}>取消</button>
          </div>}
          {!jobs.length && <p className="empty-state">选择照片后，生成你的第一张动漫参考图。</p>}
          <div className="avatar-jobs">
            {jobs.map((job) => (
              <article key={job.id}>
                <div className="avatar-job-heading"><div><strong>{job.name}</strong><small>{createdLabel(job)}</small></div>
                  <span>{job.stage} · {statusText(job)}</span></div>
                {job.preview_url && <img src={job.preview_url} alt={job.name + ' 的动漫 T-pose 参考图'} />}
                {job.error && <details className="avatar-job-error"><summary>查看失败原因</summary><pre>{job.error}</pre></details>}
                <div className="avatar-job-actions">
                  {job.preview_url && <button type="button" disabled={Boolean(deleting)}
                    onClick={() => switchWorkspace('model', job.id)}>去 3D 建模</button>}
                  {job.avatar_url && <Link href={'/?avatar=' + encodeURIComponent(job.avatar_url)}>查看 3D 角色</Link>}
                  {!isPending(job) && confirmDeleteId !== job.id &&
                    <button type="button" className="quiet-button" disabled={Boolean(deleting)}
                      onClick={() => setConfirmDeleteId(job.id)}>删除记录</button>}
                </div>
                {confirmDeleteId === job.id && <div className="avatar-record-delete-confirm" role="group" aria-label={'删除' + job.name + '的生成记录'}>
                  <span>{'同时删除该任务的原图、动漫图' + (job.avatar_url ? '和 3D 模型。' : '。')}</span>
                  <button type="button" className="danger" disabled={Boolean(deleting)}
                    onClick={() => void deleteRecord(job.id)}>{deleting === job.id ? '删除中…' : '确定删除'}</button>
                  <button type="button" disabled={Boolean(deleting)} onClick={() => setConfirmDeleteId('')}>取消</button>
                </div>}
              </article>
            ))}
          </div>
      </div>
      <div id="avatar-model-panel" role="tabpanel" aria-labelledby="avatar-model-tab"
        className="avatar-workflow-pane" hidden={workspace !== 'model'}>
          <h2>从参考图生成 3D 角色</h2>
          <p className="avatar-pane-intro">在这里选择已生成的动漫 T-pose 图片，再使用独立的 Tripo 3D 服务建模和绑骨。</p>
          <TripoSettings onConfigured={setTripoReady} />
          {referenceJobs.length ? (
            <div className="avatar-model-source">
              <div className="avatar-model-preview">
                {selectedJob?.preview_url && <img src={selectedJob.preview_url} alt={selectedJob.name + ' 的动漫参考图'} />}
              </div>
              <div className="avatar-model-controls">
                <label>选择动漫参考图<select value={selectedJob?.id ?? ''}
                  onChange={(event) => setSelectedJobId(event.target.value)}>
                  {referenceJobs.map((job) => <option key={job.id} value={job.id}>
                    {job.name} · {createdLabel(job)} · {statusText(job)}
                  </option>)}
                </select></label>
                {selectedJob && <p>{selectedJob.stage} · {statusText(selectedJob)}</p>}
                {selectedJob?.status === 'image-ready' &&
                  <button type="button" className="primary" disabled={!tripoReady || busy}
                    onClick={() => void createModel(selectedJob)}>{busy ? '正在启动…' : '确认图片，开始 3D 建模'}</button>}
                {selectedJob?.status === 'failed' && selectedJob.preview_url &&
                  <button type="button" className="primary" disabled={!tripoReady || busy}
                    onClick={() => void createModel(selectedJob)}>{busy ? '正在启动…' : '重试 3D 建模'}</button>}
                {selectedJob?.status === 'complete' && selectedJob.avatar_url &&
                  <Link className="button-link" href={'/?avatar=' + encodeURIComponent(selectedJob.avatar_url)}>打开这个 3D 角色</Link>}
                {selectedJob && isPending(selectedJob) && <p>任务正在处理，进度会自动更新。</p>}
                {selectedJob && !tripoReady && (selectedJob.status === 'image-ready' || selectedJob.status === 'failed') &&
                  <p>开始建模前，请先在上方配置 Tripo 3D 服务。</p>}
              </div>
            </div>
          ) : <div className="empty-state">还没有可用的动漫参考图。
            <button type="button" onClick={() => switchWorkspace('image')}>先去生成图片</button>
          </div>}
          {error && <p className="profile-error" role="alert">{error}</p>}
          {notice && <p className="avatar-notice" role="status">{notice}</p>}
          {selectedJob?.error && <details className="avatar-job-error"><summary>查看任务错误</summary><pre>{selectedJob.error}</pre></details>}
          <div className="section-heading avatar-record-heading"><div><h2>3D 任务记录</h2><p>只显示已进入 3D 阶段的角色</p></div></div>
          {!modelJobs.length && <p className="empty-state">确认一张动漫参考图后，就可以在这里开始 3D 建模。</p>}
          {modelJobs.length > 0 && <div className="avatar-model-history">
            {modelJobs.map((job) => <button key={job.id} type="button" className={selectedJob?.id === job.id ? 'is-selected' : ''}
              onClick={() => setSelectedJobId(job.id)}>
              <strong>{job.name}</strong><span>{job.stage} · {statusText(job)}</span>
            </button>)}
          </div>}
      </div>
    </section>
  );
}

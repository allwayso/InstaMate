'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PROFILE_CHANGE_EVENT, PROFILE_STORAGE_KEY } from '@/lib/profile-selection';

interface Profile {
  profile_id: string;
  target_speaker: string;
  profile_summary: string;
  persona_prompt: string;
  long_term_memories: { fact: string; confidence: number }[];
  personality_traits: { trait: string; description: string }[];
  limitations: string[];
}

export default function ProfileImporter() {
  const [file, setFile] = useState<File | null>(null);
  const [archiveId, setArchiveId] = useState('');
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [jobId, setJobId] = useState('');
  const [stage, setStage] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/profiles/jobs/' + jobId, { cache: 'no-store' });
        const data = await response.json() as { status?: string; profile_id?: string; error?: string };
        if (cancelled) return;
        if (!response.ok || data.status === 'failed') {
          setError(data.error ?? '分析任务失败');
          setJobId('');
        } else if (data.status === 'complete' && data.profile_id) {
          const detail = await fetch('/api/profiles/' + data.profile_id, { cache: 'no-store' });
          const result = await detail.json() as Profile;
          if (!cancelled) { setProfile(result); setStage('已完成'); setJobId(''); }
        } else {
          setStage(data.status === 'running' ? '正在分析聊天记录…' : '排队中…');
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobId]);

  async function parseZip() {
    if (!file) return;
    setError(''); setProfile(null); setStage('正在解析 ZIP…');
    try {
      const response = await fetch('/api/profiles/import', {
        method: 'POST', headers: { 'content-type': 'application/zip' }, body: file,
      });
      const data = await response.json() as {
        archive_id?: string; speakers?: string[]; message_count?: number; error?: string;
      };
      if (!response.ok || !data.archive_id) throw new Error(data.error ?? 'ZIP 解析失败');
      setArchiveId(data.archive_id);
      setSpeakers(data.speakers ?? []);
      setTarget(data.speakers?.[0] ?? '');
      setStage('已解析 ' + data.message_count + ' 条消息');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage('');
    }
  }

  async function analyze() {
    if (!archiveId || !target) return;
    setError(''); setStage('正在提交分析…');
    try {
      const response = await fetch('/api/profiles/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archive_id: archiveId, target_speaker: target }),
      });
      const data = await response.json() as { job_id?: string; error?: string };
      if (!response.ok || !data.job_id) throw new Error(data.error ?? '分析任务创建失败');
      setJobId(data.job_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage('');
    }
  }

  function activate() {
    if (!profile) return;
    localStorage.setItem(PROFILE_STORAGE_KEY, profile.profile_id);
    window.dispatchEvent(new Event(PROFILE_CHANGE_EVENT));
    setStage('已选为当前对话人物档案');
  }

  return (
    <section className="profile-panel">
      <h2>导入聊天记忆</h2>
      <p>上传包含微信聊天 TXT 的 ZIP，选择要分析的人。原始 ZIP 只在解析时使用，网页不会公开聊天内容。</p>
      <div className="profile-actions">
        <input type="file" accept=".zip,application/zip" aria-label="聊天 ZIP"
          onChange={(event) => { setFile(event.target.files?.[0] ?? null); setArchiveId(''); setSpeakers([]); }} />
        <button type="button" disabled={!file || !!jobId} onClick={() => void parseZip()}>解析 ZIP</button>
      </div>
      {!!speakers.length && (
        <div className="profile-actions">
          <label>目标说话者
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              {speakers.map((speaker) => <option key={speaker} value={speaker}>{speaker}</option>)}
            </select>
          </label>
          <button type="button" disabled={!!jobId} onClick={() => void analyze()}>生成性格与长期记忆</button>
        </div>
      )}
      {stage && <p className="profile-status" role="status">{stage}</p>}
      {error && <p className="profile-error" role="alert">{error}</p>}
      {profile && (
        <div className="profile-result">
          <h3>{profile.target_speaker} 的人物档案</h3>
          <p>{profile.profile_summary}</p>
          <h4>沟通倾向</h4>
          <ul>{profile.personality_traits.map((trait, index) =>
            <li key={index}>{trait.trait}：{trait.description}</li>)}</ul>
          <h4>长期记忆</h4>
          <ul>{profile.long_term_memories.map((memory, index) =>
            <li key={index}>{memory.fact}</li>)}</ul>
          {!!profile.limitations.length && <p>分析限制：{profile.limitations.join('；')}</p>}
          <button type="button" onClick={activate}>用于当前对话</button>
          <Link href="/states">带着档案与角色对话</Link>
        </div>
      )}
    </section>
  );
}

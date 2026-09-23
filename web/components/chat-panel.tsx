'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { PcmRecorder } from '@/lib/audio';
import { triggerState } from '@/lib/state-events';
import { speakText, stopSpeaking } from '@/lib/voice';
import { PROFILE_CHANGE_EVENT, PROFILE_STORAGE_KEY } from '@/lib/profile-selection';

type ChatMessage = { role: 'user' | 'assistant'; content: string; source?: 'voice'; triggered?: string[] };
type ChatTrigger = {
  id: string; name: string; emotion: string; duration: number | null; loop: boolean; clip_id: string | null;
};
const STORAGE_KEY = 'instamate-chat-session-v1';
const newSessionId = () => 'session-' + crypto.randomUUID();

export default function ChatPanel() {
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [profileId, setProfileId] = useState('');
  const [profiles, setProfiles] = useState<{ profile_id: string; target_speaker: string }[]>([]);
  const [error, setError] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingBusyRef = useRef(false);
  const sendingRef = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const id = stored && /^[A-Za-z0-9_-]{1,128}$/.test(stored) ? stored : newSessionId();
    localStorage.setItem(STORAGE_KEY, id);
    setSessionId(id);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void recorderRef.current?.stop();
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    const sync = () => {
      setProfileId(localStorage.getItem(PROFILE_STORAGE_KEY) ?? '');
      void fetch('/api/profiles').then((response) => response.json())
        .then((data: { profiles?: { profile_id: string; target_speaker: string }[] }) =>
          setProfiles(Array.isArray(data.profiles) ? data.profiles : []))
        .catch(() => setProfiles([]));
    };
    sync();
    window.addEventListener(PROFILE_CHANGE_EVENT, sync);
    return () => window.removeEventListener(PROFILE_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch('/api/chat?session_id=' + encodeURIComponent(sessionId), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? '对话记录读取失败');
        return data as { messages?: ChatMessage[] };
      })
      .then((data) => setMessages(Array.isArray(data.messages) ? data.messages : []))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    const list = messagesRef.current;
    list?.scrollTo({ top: list.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [messages, sending, recognizing]);

  async function submitMessage(message: string, source?: 'voice') {
    const text = message.trim();
    if (!text || !sessionId || loading || sendingRef.current) return;
    sendingRef.current = true;
    setDraft('');
    setError('');
    setVoiceError('');
    setSending(true);
    setMessages((current) => [...current, { role: 'user', content: text, source }]);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, message: text, profile_id: profileId || null }),
      });
      const data = await response.json() as { answer?: string; triggers?: ChatTrigger[]; error?: string };
      if (!response.ok || typeof data.answer !== 'string') throw new Error(data.error ?? '对话失败');
      const triggers = Array.isArray(data.triggers) ? data.triggers : [];
      setMessages((current) => [...current, {
        role: 'assistant', content: data.answer!, triggered: triggers.map((trigger) => trigger.name),
      }]);
      for (const trigger of triggers) {
        triggerState({
          id: trigger.id, name: trigger.name, duration: trigger.duration, loop: trigger.loop,
          clipId: trigger.clip_id, emotion: trigger.emotion,
        }, 'chat');
      }
      if (voiceOn && data.answer) {
        void speakText(data.answer).catch((cause: unknown) =>
          setVoiceError(cause instanceof Error ? cause.message : '语音播报失败'));
      }
    } catch (cause) {
      setDraft(text);
      setMessages((current) => current.slice(0, -1));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recording && !recognizing) void submitMessage(draft);
  }

  function newConversation() {
    stopSpeaking();
    const id = newSessionId();
    localStorage.setItem(STORAGE_KEY, id);
    setMessages([]);
    setDraft('');
    setSessionId(id);
  }

  async function finishRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recordingBusyRef.current) return;
    recordingBusyRef.current = true;
    recorderRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setRecording(false);
    setRecognizing(true);
    try {
      const audio = await recorder.stop();
      if (!audio) throw new Error('录音为空，请再试一次');
      const response = await fetch('/api/asr', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio }),
      });
      const data = await response.json() as { text?: string; error?: string };
      if (!response.ok || !data.text?.trim()) throw new Error(data.error ?? '没有听清，请再说一次');
      setRecognizing(false);
      await submitMessage(data.text, 'voice');
    } catch (cause) {
      setVoiceError(cause instanceof Error ? cause.message : '语音识别失败');
    } finally {
      setRecognizing(false);
      recordingBusyRef.current = false;
    }
  }

  async function toggleRecording() {
    if (recording) { await finishRecording(); return; }
    if (loading || sending || recognizing || recordingBusyRef.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError('麦克风需要 HTTPS 或 localhost。');
      return;
    }
    recordingBusyRef.current = true;
    setVoiceError('');
    stopSpeaking();
    const recorder = new PcmRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setRecording(true);
      timerRef.current = setTimeout(() => { void finishRecording(); }, 30_000);
    } catch (cause) {
      recorderRef.current = null;
      await recorder.stop().catch(() => null);
      setVoiceError(cause instanceof Error ? cause.message : '无法启动麦克风');
    } finally {
      recordingBusyRef.current = false;
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="chat-panel" aria-label="影伴对话">
      <div className="chat-panel-head">
        <div><span className="eyebrow">一段新的日常</span><h2>和影伴聊聊</h2>
          <label className="chat-profile">人物档案
            <select value={profileId} onChange={(event) => {
              const next = event.target.value;
              setProfileId(next);
              if (next) localStorage.setItem(PROFILE_STORAGE_KEY, next);
              else localStorage.removeItem(PROFILE_STORAGE_KEY);
              window.dispatchEvent(new Event(PROFILE_CHANGE_EVENT));
            }}>
              <option value="">默认影伴</option>
              {profiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>
                {profile.target_speaker}
              </option>)}
            </select>
          </label>
        </div>
        <button type="button" onClick={newConversation} disabled={!sessionId || sending || recording || recognizing}>新对话</button>
      </div>
      <div className="chat-messages" role="log" aria-live="polite" ref={messagesRef}>
        {loading && <p className="chat-placeholder">正在读取对话…</p>}
        {!loading && messages.length === 0 && <div className="chat-empty">
          <span className="companion-symbol" aria-hidden="true"><i /><i /></span>
          <h3>从一句你好开始</h3>
          <p>打字，或用声音分享此刻。<br />你们的对话会被记住。</p>
          <div className="chat-suggestions">
            {['你好，认识一下吧', '今天有什么开心的事？'].map((text) => <button key={text} type="button" onClick={() => { setDraft(text); draftRef.current?.focus(); }}>{text}<span aria-hidden="true">↗</span></button>)}
          </div>
        </div>}
        {messages.map((item, index) => (
          <div key={index} className={'chat-message ' + item.role}>
            <span>{item.role === 'user' ? (item.source === 'voice' ? '你 · 语音' : '你') : '影伴'}</span>
            <p>{item.content}</p>
            {!!item.triggered?.length && <small>已触发：{item.triggered.join('、')}</small>}
          </div>
        ))}
        {sending && <p className="chat-placeholder">影伴正在回复…</p>}
        {recognizing && <p className="chat-placeholder">正在转写语音…</p>}
      </div>
      {error && <p className="chat-error" role="alert">{error}</p>}
      {voiceError && <p className="chat-error" role="alert">{voiceError}</p>}
      <form className="chat-form" onSubmit={send}>
        <div className="composer-status" role="status">{recording ? '正在录音 · 再次点击麦克风即可发送' : recognizing ? '正在将声音转成文字…' : '文字或语音，都能触发角色回应'}</div>
        <button type="button" className={'chat-mic' + (recording ? ' is-recording' : '')}
          onClick={() => void toggleRecording()} disabled={loading || sending || recognizing}
          aria-pressed={recording} aria-label={recording ? '停止录音并发送' : '开始语音输入'}><span className="mic-symbol" aria-hidden="true" />{recording ? '停止录音' : '语音'}</button>
        <textarea ref={draftRef} aria-label="输入消息" value={draft} disabled={recording || recognizing}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown}
          placeholder="想和影伴说点什么？" maxLength={20_000} rows={3} />
        <div className="chat-form-actions">
          <button type="submit" disabled={!draft.trim() || !sessionId || loading || sending || recording || recognizing}>发送</button>
          <button type="button" onClick={() => { if (voiceOn) stopSpeaking(); setVoiceOn(!voiceOn); }}
            aria-pressed={voiceOn} aria-label={voiceOn ? '关闭语音播报' : '开启语音播报'}>{voiceOn ? '播报已开' : '播报已关'}</button>
        </div>
        <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
      </form>
    </section>
  );
}

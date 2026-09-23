'use client';

import { cleanSpokenReply } from './spoken-reply.js';

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let currentRequest: AbortController | null = null;
let generation = 0;

export function stopSpeaking(): void {
  generation += 1;
  currentRequest?.abort();
  currentRequest = null;
  currentAudio?.pause();
  currentAudio = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
}

/** 合成并播放 Qwen-Audio-3.0-TTS-Plus 的回复音频。 */
export async function speakText(text: string): Promise<void> {
  const spoken = cleanSpokenReply(text);
  if (!spoken) return;
  stopSpeaking();
  const sequence = generation;
  const controller = new AbortController();
  currentRequest = controller;
  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(payload?.error ?? '语音播报失败');
    }
    const blob = await response.blob();
    if (sequence !== generation) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentUrl = url;
    currentAudio = audio;
    currentRequest = null;
    audio.onended = () => {
      if (currentAudio === audio) stopSpeaking();
    };
    audio.onerror = () => {
      if (currentAudio === audio) stopSpeaking();
    };
    await audio.play();
  } catch (error) {
    if (sequence !== generation || controller.signal.aborted) return;
    stopSpeaking();
    throw error;
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { cleanSpokenReply } from '@/lib/spoken-reply';
import { localRequestOnly } from '@/lib/local-request';

export const runtime = 'nodejs';

const API_KEY = process.env.DASHSCOPE_API_KEY ?? '';
const GATEWAY =
  process.env.DASHSCOPE_WS_URL ?? 'https://dashscope.aliyuncs.com/api/v1';
const TTS_VOICE = process.env.QWEN_TTS_VOICE ?? 'longanlingxin';
const TTS_TIMEOUT_MS = 60_000;

export async function POST(request: NextRequest) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    const payload = (await request.json()) as { text?: string };
    const text = cleanSpokenReply(
      typeof payload.text === 'string' ? payload.text : '',
    );
    if (!text)
      return NextResponse.json({ error: '合成文本为空' }, { status: 400 });
    if (text.length > 2000)
      return NextResponse.json({ error: '合成文本过长' }, { status: 400 });
    if (!API_KEY)
      return NextResponse.json(
        { error: '服务器未配置 DASHSCOPE_API_KEY' },
        { status: 500 },
      );

    const upstream = await fetch(
      `${new URL(GATEWAY).origin}/api/v1/services/audio/tts/SpeechSynthesizer`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: 'qwen-audio-3.0-tts-plus',
          input: {
            text,
            voice: TTS_VOICE,
            format: 'mp3',
            sample_rate: 24000,
          },
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      },
    );
    const result = (await upstream.json().catch(() => null)) as {
      code?: string;
      message?: string;
      output?: { audio?: { url?: string } };
    } | null;
    if (!upstream.ok || !result?.output?.audio?.url) {
      return NextResponse.json(
        {
          error: '语音合成失败',
          detail: result?.code ?? `tts_http_${upstream.status}`,
        },
        { status: 502 },
      );
    }
    const audio = await fetch(result.output.audio.url, {
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!audio.ok)
      return NextResponse.json({ error: '合成音频下载失败' }, { status: 502 });
    return new Response(audio.body, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '语音合成暂不可用',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

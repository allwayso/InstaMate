import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';
import { localRequestOnly } from '@/lib/local-request';

export const runtime = 'nodejs';

const API_KEY = process.env.DASHSCOPE_API_KEY ?? '';
const GATEWAY =
  process.env.DASHSCOPE_WS_URL ?? 'https://dashscope.aliyuncs.com/api/v1';
const MAX_AUDIO_BYTES = 30 * 16_000 * 2;
const ASR_TIMEOUT_MS = 75_000;

function readPcmWav(value: string): Buffer {
  const base64 = value.replace(/^data:audio\/wav;base64,/, '');
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    base64.length > Math.ceil(((MAX_AUDIO_BYTES + 44) * 4) / 3) + 4
  ) {
    throw new Error('音频格式无效或超过 30 秒');
  }
  const wav = Buffer.from(base64, 'base64');
  if (
    wav.length < 45 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.toString('ascii', 12, 16) !== 'fmt ' ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== 16_000 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString('ascii', 36, 40) !== 'data'
  ) {
    throw new Error('只支持 16 kHz、16 bit、单声道 PCM WAV');
  }
  const length = wav.readUInt32LE(40);
  if (
    length < 2 ||
    length > MAX_AUDIO_BYTES ||
    length % 2 !== 0 ||
    wav.length < length + 44
  ) {
    throw new Error('音频数据为空或超过 30 秒');
  }
  return wav.subarray(44, 44 + length);
}

async function recognize(pcm: Buffer, signal: AbortSignal): Promise<string> {
  const gateway = new URL(GATEWAY);
  const protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${gateway.host}/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus`;
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    handshakeTimeout: 10_000,
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    let streaming = false;
    let transcript = '';
    let interim = '';
    let finalTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(
      () => finish(new Error('语音识别超时')),
      ASR_TIMEOUT_MS,
    );

    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (finalTimer) clearTimeout(finalTimer);
      signal.removeEventListener('abort', onAbort);
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
      if (error) reject(error);
      else resolve(transcript.trim());
    }
    function onAbort() {
      finish(new Error('请求已取消'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    socket.on('message', (data) => {
      let item: {
        type?: string;
        transcript?: string;
        text?: string;
        stash?: string;
        error?: { code?: string; message?: string };
      };
      try {
        item = JSON.parse(String(data));
      } catch {
        return;
      }
      if (item.type === 'error') {
        finish(
          new Error(
            `语音模型错误：${item.error?.code ?? item.error?.message ?? 'unknown'}`,
          ),
        );
      } else if (item.type === 'session.updated' && !streaming) {
        streaming = true;
        void (async () => {
          for (
            let offset = 0;
            offset < pcm.length && !finished;
            offset += 3200
          ) {
            socket.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: pcm.subarray(offset, offset + 3200).toString('base64'),
              }),
            );
            await new Promise((done) => setTimeout(done, 100));
          }
          if (finished) return;
          socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          socket.send(
            JSON.stringify({
              type: 'response.create',
              response: { modalities: ['text'] },
            }),
          );
        })().catch((error) =>
          finish(error instanceof Error ? error : new Error('发送音频失败')),
        );
      } else if (
        item.type === 'conversation.item.input_audio_transcription.delta'
      ) {
        interim = `${item.text ?? ''}${item.stash ?? ''}`;
      } else if (
        item.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        transcript = item.transcript ?? '';
        finish(transcript ? undefined : new Error('没有听清，请再说一次'));
      } else if (
        item.type === 'conversation.item.input_audio_transcription.failed'
      ) {
        finish(new Error('语音转写失败'));
      } else if (item.type === 'response.done') {
        finalTimer = setTimeout(() => {
          transcript = interim;
          finish(transcript ? undefined : new Error('没有听清，请再说一次'));
        }, 2_000);
      }
    });
    socket.on('error', () => finish(new Error('语音模型连接失败')));
    socket.on('close', () => finish(new Error('语音模型连接中断')));
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          turn_detection: null,
          instructions: '请只转写用户语音。',
        },
      }));
    });
  });
}

export async function POST(request: NextRequest) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  if (!API_KEY)
    return NextResponse.json(
      { error: '服务器未配置 DASHSCOPE_API_KEY' },
      { status: 500 },
    );
  try {
    const payload = (await request.json()) as { audio?: string };
    if (typeof payload.audio !== 'string')
      return NextResponse.json({ error: '音频数据为空' }, { status: 400 });
    let pcm: Buffer;
    try {
      pcm = readPcmWav(payload.audio);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '音频格式无效' },
        { status: 400 },
      );
    }
    const text = await recognize(pcm, request.signal);
    return NextResponse.json(
      { text },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '语音识别暂不可用' },
      { status: 502 },
    );
  }
}

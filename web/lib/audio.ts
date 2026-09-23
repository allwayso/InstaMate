'use client';

/** 浏览器录音工具：getUserMedia + AudioWorklet 采集 PCM，编码为 16kHz 16bit 单声道 WAV */

import {
  classifyMicFailure,
  collectAudioInputLabels,
  describeMicFailure,
} from './mic-diagnostics';

const TARGET_SAMPLE_RATE = 16000;

const WORKLET_CODE = `
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('instamate-recorder', RecorderProcessor);
`;

export function bufferToBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = samples[Math.min(index + 1, samples.length - 1)];
    output[i] = (samples[index] ?? 0) * (1 - fraction) + next * fraction;
  }
  return output;
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = TARGET_SAMPLE_RATE;
  private workletUrl: string | null = null;

  get recording(): boolean {
    return this.context !== null;
  }

  async start(): Promise<void> {
    if (this.context) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(
        (this.workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))),
      );
      this.sampleRate = this.context.sampleRate;
      this.chunks = [];
      const source = this.context.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.context, 'instamate-recorder');
      this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.chunks.push(event.data);
      };
      source.connect(this.workletNode);
      this.workletNode.connect(this.context.destination);
    } catch (error) {
      this.workletNode?.disconnect();
      this.workletNode = null;
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      await this.context?.close().catch(() => undefined);
      this.context = null;
      if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;

      // ★ 把浏览器的原始 DOMException 换成人能看懂的话。
      //   原来直接往上抛，用户看到的是：
      //       NotFoundError: Requested device not found
      //   而这背后可能是五种完全不同的情况（没设备 / 没权限 / 被占用 /
      //   参数不满足 / 非安全上下文），处理办法没有一条重合。
      //
      //   特别注意「没设备」这一种：在 Windows 上「外部麦克风」可以存在于
      //   设备管理器、甚至能被 enumerateDevices 列出来，但状态是「未插入」，
      //   getUserMedia 照样抛 NotFoundError —— 所以出错后补一次枚举，
      //   把设备名列清楚，让用户知道问题在系统侧而不在页面侧。
      const failure = classifyMicFailure(error);
      const labels = await collectAudioInputLabels(() =>
        navigator.mediaDevices.enumerateDevices(),
      );
      throw new Error(
        describeMicFailure(failure, {
          labels,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** 停止录音，返回 16kHz WAV 的 base64；未在录音时返回 null */
  async stop(): Promise<string | null> {
    if (!this.context) return null;
    const context = this.context;
    this.context = null;
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await context.close();
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const resampled = resampleLinear(merged, this.sampleRate, TARGET_SAMPLE_RATE);
    return bufferToBase64(encodeWav(resampled, TARGET_SAMPLE_RATE));
  }
}

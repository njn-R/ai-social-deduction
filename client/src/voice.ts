import type { KokoroTTS } from 'kokoro-js';
import type { VoiceSpec } from '../../src/shared/protocol';

export type VoiceStatus = 'off' | 'loading' | 'ready' | 'error';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * Reads AI meeting lines aloud with Kokoro, entirely in the browser.
 *
 * Runs on the CPU (WebAssembly, 8-bit model, ~90 MB, downloaded once and cached by the
 * browser) so the GPU stays free for the language model. Lines play one after another;
 * `onSpeaking` reports when it starts and stops so the server can hold the next line.
 */
export class Voices {
  status: VoiceStatus = 'off';
  /** Download progress, 0-100, while loading. */
  progress = 0;
  error = '';
  onStatus?: () => void;
  onSpeaking?: (on: boolean) => void;

  private tts: KokoroTTS | null = null;
  private loading: Promise<void> | null = null;
  private audio: AudioContext | null = null;
  private queue: { text: string; spec: VoiceSpec }[] = [];
  private busy = false;
  private speaking = false;
  private current: AudioBufferSourceNode | null = null;

  constructor(public enabled: boolean) {
    if (enabled) void this.load();
  }

  /** Call from a click or key press: browsers only allow sound after a user gesture. */
  unlock(): void {
    this.audio ??= new AudioContext();
    void this.audio.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) void this.load();
    else this.stop();
    this.onStatus?.();
  }

  say(text: string, spec: VoiceSpec | undefined): void {
    if (!this.enabled || !spec || !text.trim()) return;
    this.queue.push({ text, spec });
    void this.pump();
  }

  /** Stop talking and forget anything queued (e.g. the meeting ended). */
  stop(): void {
    this.queue = [];
    try {
      this.current?.stop();
    } catch {
      // already stopped
    }
    this.current = null;
    this.setSpeaking(false);
  }

  private load(): Promise<void> {
    if (this.tts) return Promise.resolve();
    if (this.loading) return this.loading;
    this.status = 'loading';
    this.progress = 0;
    this.onStatus?.();
    this.loading = (async () => {
      try {
        const { KokoroTTS } = await import('kokoro-js');
        this.tts = await KokoroTTS.from_pretrained(MODEL, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (p: unknown) => {
            const info = p as { status?: string; file?: string; progress?: number };
            if (info.status === 'progress' && info.file?.endsWith('.onnx') && typeof info.progress === 'number') {
              this.progress = Math.round(info.progress);
              this.onStatus?.();
            }
          },
        });
        this.status = 'ready';
      } catch (e) {
        this.status = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        this.loading = null;
      }
      this.onStatus?.();
    })();
    return this.loading;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.enabled && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.setSpeaking(true);
      try {
        await this.load();
        if (!this.tts) break;
        const clip = await this.tts.generate(next.text, { voice: next.spec.kokoro as never, speed: next.spec.speed });
        if (!this.enabled) break;
        await this.play(clip.audio, clip.sampling_rate);
      } catch (e) {
        console.warn('Could not speak a line:', e);
      }
    }
    this.busy = false;
    if (this.queue.length === 0) this.setSpeaking(false);
  }

  private play(samples: Float32Array, rate: number): Promise<void> {
    this.audio ??= new AudioContext();
    const ctx = this.audio;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    this.current = src;
    return new Promise((resolve) => {
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      src.start();
    });
  }

  private setSpeaking(on: boolean): void {
    if (on === this.speaking) return;
    this.speaking = on;
    this.onSpeaking?.(on);
  }
}

export function describeVoices(v: Voices): string {
  if (!v.enabled) return 'Voices off';
  switch (v.status) {
    case 'loading':
      return `Loading voices... ${v.progress}% (one-time ~90 MB download)`;
    case 'ready':
      return 'Voices ready';
    case 'error':
      return `Voices failed to load: ${v.error}`;
    default:
      return 'Voices on';
  }
}

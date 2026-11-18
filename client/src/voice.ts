import type { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import type { VoiceSpec } from '../../src/shared/protocol';

export type VoiceStatus = 'off' | 'loading' | 'ready' | 'error';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** Ask the server for the next line once this little speech is left, so it's ready in time. */
const LEAD_SEC = 1.5;

/**
 * Reads AI meeting lines aloud with Kokoro, entirely in the browser.
 *
 * Runs on the CPU (WebAssembly, 8-bit model, ~90 MB, downloaded once and cached by the
 * browser) so the GPU stays free for the language model. Each line is spoken sentence by
 * sentence as it's generated, and clips are scheduled back to back, so the next line can be
 * generated while the current one is still playing.
 *
 * `onBusy` tells the server to hold the next line: true while lines are waiting to be voiced
 * or more than a moment of speech is still queued up.
 */
export class Voices {
  status: VoiceStatus = 'off';
  /** Download progress, 0-100, while loading. */
  progress = 0;
  error = '';
  /** User speed setting, multiplied with each persona's own speed. */
  rate = 1;
  onStatus?: () => void;
  onBusy?: (busy: boolean) => void;
  /** Time from a line arriving to its first sound, for checking speed. */
  readonly stats: { waitMs: number; chars: number }[] = [];

  private tts: KokoroTTS | null = null;
  private Splitter: typeof TextSplitterStream | null = null;
  private loading: Promise<void> | null = null;
  private audio: AudioContext | null = null;
  private queue: { text: string; spec: VoiceSpec; at: number }[] = [];
  private generating = false;
  /** AudioContext time when everything scheduled so far finishes playing. */
  private endAt = 0;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private busy = false;
  private timer: number | null = null;

  constructor(public enabled: boolean) {
    if (enabled) void this.load();
  }

  get ready(): boolean {
    return this.enabled && this.status === 'ready';
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
    // Lines that arrive before the voices have loaded are skipped, not saved up for later.
    if (!this.ready || !spec || !text.trim()) return;
    this.queue.push({ text, spec, at: performance.now() });
    this.report();
    void this.generate();
  }

  /** Stop talking and forget anything queued (e.g. the meeting ended). */
  stop(): void {
    this.queue = [];
    for (const src of this.playing) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    this.endAt = 0;
    this.report();
  }

  private load(): Promise<void> {
    if (this.tts) return Promise.resolve();
    if (this.loading) return this.loading;
    this.status = 'loading';
    this.progress = 0;
    this.onStatus?.();
    this.loading = (async () => {
      try {
        const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
        this.Splitter = TextSplitterStream;
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

  /** Voice queued lines one after another, scheduling each sentence as soon as it's ready. */
  private async generate(): Promise<void> {
    if (this.generating) return;
    this.generating = true;
    try {
      while (this.ready && this.queue.length > 0) {
        const line = this.queue.shift()!;
        // Pass a closed splitter: given a plain string, kokoro-js leaves its splitter open and
        // waits forever after the last full sentence.
        const sentences = new this.Splitter!();
        sentences.push(line.text);
        sentences.close();
        let first = true;
        for await (const part of this.tts!.stream(sentences, { voice: line.spec.kokoro as never, speed: line.spec.speed * this.rate })) {
          if (!this.ready) break;
          if (first) {
            this.stats.push({ waitMs: Math.round(performance.now() - line.at), chars: line.text.length });
            first = false;
          }
          this.schedule(part.audio.audio, part.audio.sampling_rate);
        }
        this.report();
      }
    } catch (e) {
      console.warn('Could not speak a line:', e);
    } finally {
      this.generating = false;
      this.report();
    }
  }

  private schedule(samples: Float32Array, rate: number): void {
    this.audio ??= new AudioContext();
    const ctx = this.audio;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.endAt);
    src.start(at);
    this.endAt = at + buffer.duration;
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      this.report();
    };
    this.report();
  }

  /** Tell the server whether to hold the next line, and keep checking while audio plays. */
  private report(): void {
    const left = this.audio ? this.endAt - this.audio.currentTime : 0;
    const busy = this.ready && (this.queue.length > 0 || left > LEAD_SEC);
    if (busy !== this.busy) {
      this.busy = busy;
      this.onBusy?.(busy);
    }
    const active = busy || left > 0 || this.generating;
    if (active && this.timer === null) this.timer = window.setInterval(() => this.report(), 200);
    if (!active && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function describeVoices(v: Voices): string {
  if (!v.enabled) return 'Voices off';
  switch (v.status) {
    case 'loading':
      return `Loading voices... ${v.progress}% (one-time ~90 MB download)`;
    case 'ready':
      return `Voices ready${crossOriginIsolated ? '' : ' (single-threaded: may lag)'}`;
    case 'error':
      return `Voices failed to load: ${v.error}`;
    default:
      return 'Voices on';
  }
}

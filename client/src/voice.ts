import type { VoiceSpec } from '../../src/shared/protocol';

export type VoiceStatus = 'off' | 'loading' | 'ready' | 'error';

/** Ask the server for the next line once this little speech is left, so it's ready in time. */
const LEAD_SEC = 1.5;

/** One sentence that's about to be heard: when it starts and how long it lasts. */
export interface Spoken {
  key: string;
  text: string;
  startMs: number;
  durationMs: number;
}

export interface VoiceCheck {
  ok: boolean;
  zcr: number;
  rms: number;
  peak: number;
  samples: number;
}

interface Line {
  key: string;
  text: string;
  spec: VoiceSpec;
  at: number;
  spoke?: boolean;
}

/**
 * Reads AI meeting lines aloud with Kokoro. Speech is generated on a background worker, on
 * the GPU when the browser supports WebGPU (~330 MB model, downloaded once) or else the CPU
 * (~90 MB), so the game never freezes. This side only plays the audio.
 *
 * Lines are voiced one at a time; each sentence is scheduled to start exactly when the
 * previous one ends, so voices never overlap. `onSpoken` reports each sentence's timing so the
 * chat can type out the words in step with the voice.
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
  /** Where speech is generated: the GPU (WebGPU) or the CPU (WebAssembly). */
  device: 'webgpu' | 'wasm' | null = null;
  /** Why the GPU wasn't used, when it was tried and rejected. */
  note = '';
  /** Measurements from the start-up voice check (for diagnosing static). */
  check: { cpu: VoiceCheck; gpu: VoiceCheck | null } | null = null;
  /** Skip the GPU and always use the CPU. */
  preferCpu = false;
  onStatus?: () => void;
  onBusy?: (busy: boolean) => void;
  onSpoken?: (s: Spoken) => void;
  /** A line finished (or was dropped); `spoke` says whether any of it was heard. */
  onLineDone?: (key: string, spoke: boolean) => void;
  /** Time from a line arriving to its first sound, for checking speed. */
  readonly stats: { waitMs: number; chars: number }[] = [];

  private worker: Worker | null = null;
  private audio: AudioContext | null = null;
  private queue: Line[] = [];
  private current: Line | null = null;
  /** AudioContext time when everything scheduled so far finishes playing. */
  private endAt = 0;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private busy = false;
  private timer: number | null = null;

  constructor(
    public enabled: boolean,
    preferCpu = false,
  ) {
    this.preferCpu = preferCpu;
    if (enabled) this.load();
  }

  /** Switch between "GPU if it works" and "CPU only"; reloads the voice engine. */
  setPreferCpu(on: boolean): void {
    if (on === this.preferCpu) return;
    this.preferCpu = on;
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.status = 'off';
    this.device = null;
    this.note = '';
    if (this.enabled) this.load();
    this.onStatus?.();
  }

  get ready(): boolean {
    return this.enabled && this.status === 'ready';
  }

  /** True if this line is queued or being voiced right now. */
  owns(key: string): boolean {
    return this.current?.key === key || this.queue.some((l) => l.key === key);
  }

  /** Call from a click or key press: browsers only allow sound after a user gesture. */
  unlock(): void {
    this.audio ??= new AudioContext();
    void this.audio.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.load();
    else this.stop();
    this.onStatus?.();
  }

  /** Play a sample line right away (lobby "Test voice" button). */
  test(spec: VoiceSpec): boolean {
    this.unlock();
    return this.say(`test:${performance.now()}`, 'Hello! This is how I sound. Do I sound clear to you?', spec);
  }

  /** Queue a line to be read aloud. Returns false if voices can't take it (off or still loading). */
  say(key: string, text: string, spec: VoiceSpec | undefined): boolean {
    if (!this.ready || !spec || !text.trim()) return false;
    this.queue.push({ key, text, spec, at: performance.now() });
    this.next();
    this.report();
    return true;
  }

  /** Stop talking and drop anything queued (the meeting ended, voices muted, new game). */
  stop(): void {
    const dropped = [...(this.current ? [this.current] : []), ...this.queue];
    this.queue = [];
    this.current = null;
    this.worker?.postMessage({ type: 'cancel' });
    for (const src of this.playing) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    this.endAt = 0;
    for (const line of dropped) this.onLineDone?.(line.key, false);
    this.report();
  }

  private load(): void {
    if (this.worker) return;
    this.status = 'loading';
    this.progress = 0;
    this.onStatus?.();
    this.worker = new Worker(new URL('./voiceWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => this.onWorker(e.data);
    this.worker.onerror = (e) => {
      this.status = 'error';
      this.error = e.message || 'voice worker crashed';
      this.onStatus?.();
    };
    this.worker.postMessage({ type: 'load', preferCpu: this.preferCpu });
  }

  private onWorker(msg: {
    type: string;
    id?: string;
    text?: string;
    audio?: Float32Array;
    rate?: number;
    progress?: number;
    message?: string;
    device?: 'webgpu' | 'wasm';
    note?: string;
    check?: Voices['check'];
  }): void {
    switch (msg.type) {
      case 'device':
        this.device = msg.device ?? null;
        this.onStatus?.();
        return;
      case 'progress':
        this.progress = msg.progress ?? 0;
        this.onStatus?.();
        return;
      case 'ready':
        this.status = 'ready';
        this.device = msg.device ?? this.device;
        this.note = msg.note ?? '';
        this.check = msg.check ?? null;
        console.info('Voices ready', { device: this.device, check: this.check, note: this.note });
        this.onStatus?.();
        return;
      case 'error':
        this.status = 'error';
        this.error = msg.message ?? 'unknown error';
        this.onStatus?.();
        return;
      case 'chunk': {
        const line = this.current;
        if (!line || line.key !== msg.id || !this.enabled) return; // stale: cancelled meanwhile
        if (!line.spoke) this.stats.push({ waitMs: Math.round(performance.now() - line.at), chars: line.text.length });
        line.spoke = true;
        this.schedule(line.key, msg.text ?? '', msg.audio!, msg.rate!);
        return;
      }
      case 'done': {
        const line = this.current;
        if (!line || line.key !== msg.id) return;
        this.current = null;
        this.onLineDone?.(line.key, !!line.spoke);
        this.next();
        this.report();
        return;
      }
    }
  }

  /** Hand the worker the next line, one at a time so voices stay in order. */
  private next(): void {
    if (this.current || this.queue.length === 0 || !this.worker || this.status !== 'ready') return;
    this.current = this.queue.shift()!;
    const { key, text, spec } = this.current;
    this.worker.postMessage({ type: 'speak', id: key, text, voice: spec.kokoro, speed: spec.speed * this.rate });
  }

  private schedule(key: string, text: string, samples: Float32Array, rate: number): void {
    this.audio ??= new AudioContext();
    const ctx = this.audio;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // Never before the previous clip ends: one voice at a time.
    const at = Math.max(ctx.currentTime + 0.03, this.endAt);
    src.start(at);
    this.endAt = at + buffer.duration;
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      this.report();
    };
    this.onSpoken?.({ key, text, startMs: performance.now() + (at - ctx.currentTime) * 1000, durationMs: buffer.duration * 1000 });
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
    const active = busy || left > 0 || !!this.current;
    if (active && this.timer === null) this.timer = window.setInterval(() => this.report(), 200);
    if (!active && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function describeVoices(v: Voices): string {
  if (!v.enabled) return 'Voices off';
  const gpu = v.device === 'webgpu';
  switch (v.status) {
    case 'loading':
      return `Loading voices${v.device ? (gpu ? ' for the GPU' : ' for the CPU') : ''}... ${v.progress}% (one-time ${gpu ? '~330' : '~90'} MB download)`;
    case 'ready':
      if (gpu) return 'Voices ready (GPU, checked against the CPU voice)';
      if (v.note) {
        const chromium = /Chrome\/|Edg\//.test(navigator.userAgent);
        const hint = chromium ? ' Updating your browser or graphics driver may fix it.' : ' Chrome or Edge usually run GPU voices fine.';
        return `Voices ready (CPU): ${v.note}, so it switched to the CPU.${hint}`;
      }
      return `Voices ready (CPU${crossOriginIsolated ? '' : ', single-threaded: may lag'})`;
    case 'error':
      return `Voices failed to load: ${v.error}`;
    default:
      return 'Voices on';
  }
}

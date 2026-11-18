/**
 * Background thread for text-to-speech, so generating speech never freezes the game.
 *
 * Messages in:  { type: 'load', preferCpu } | { type: 'speak', id, text, voice, speed } | { type: 'cancel' }
 * Messages out: { type: 'device', device } | { type: 'progress', progress } | { type: 'ready', device, note }
 *               { type: 'error', message }
 *               { type: 'chunk', id, text, audio, rate }   (one per sentence, audio transferred)
 *               { type: 'done', id }
 */
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

interface Job {
  id: string;
  text: string;
  voice: string;
  speed: number;
  gen: number;
}

// Worker globals, typed loosely so this file builds with the DOM lib.
const port = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let tts: KokoroTTS | null = null;
let loading = false;
let generation = 0;
let working = false;
const jobs: Job[] = [];

port.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; preferCpu?: boolean } & Partial<Job>;
  if (msg.type === 'load') void load(msg.preferCpu === true);
  if (msg.type === 'speak') {
    jobs.push({ id: msg.id!, text: msg.text!, voice: msg.voice!, speed: msg.speed ?? 1, gen: generation });
    void work();
  }
  if (msg.type === 'cancel') {
    generation++;
    jobs.length = 0;
  }
};

/** Use the GPU (WebGPU) when the browser offers it; otherwise the CPU (WebAssembly). */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return gpu && (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

const progress = (p: unknown) => {
  const info = p as { status?: string; file?: string; progress?: number };
  if (info.status === 'progress' && info.file?.endsWith('.onnx') && typeof info.progress === 'number') {
    port.postMessage({ type: 'progress', progress: Math.round(info.progress) });
  }
};

/**
 * Speak a test sentence and check it sounds like speech. On some GPUs/drivers the WebGPU model
 * produces static instead of a voice; static crosses zero on most samples, speech rarely does.
 */
const CHECK_LINE = 'Hello there, this is a quick voice check.';

async function speakCheck(engine: KokoroTTS): Promise<Check> {
  const clip = await engine.generate(CHECK_LINE, { voice: 'af_heart' });
  return measure(clip.audio);
}

interface Check {
  ok: boolean;
  /** Zero-crossing rate: Kokoro speech measures ~0.25, white noise ~0.5. */
  zcr: number;
  rms: number;
  /** Loudest sample; above ~1 it clips into crackle. */
  peak: number;
  samples: number;
}

/**
 * Does the GPU voice sound like the CPU voice? On some GPUs/drivers the WebGPU model produces
 * static; comparing against the CPU model on the same sentence catches that without guessing
 * absolute thresholds.
 */
function sameVoice(gpu: Check, cpu: Check): boolean {
  const ratio = (a: number, b: number) => (b === 0 ? Infinity : a / b);
  return (
    gpu.ok &&
    Math.abs(gpu.zcr - cpu.zcr) < 0.06 &&
    ratio(gpu.rms, cpu.rms) > 0.6 &&
    ratio(gpu.rms, cpu.rms) < 1.6 &&
    ratio(gpu.samples, cpu.samples) > 0.75 &&
    ratio(gpu.samples, cpu.samples) < 1.33
  );
}

function measure(a: Float32Array): Check {
  let crossings = 0;
  let energy = 0;
  let peak = 0;
  let broken = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) broken++;
    energy += v * v;
    peak = Math.max(peak, Math.abs(v));
    if (i > 0 && a[i - 1] >= 0 !== v >= 0) crossings++;
  }
  const zcr = crossings / Math.max(1, a.length);
  const rms = Math.sqrt(energy / Math.max(1, a.length));
  // Loose sanity limits; the real test is sameVoice() against the CPU model.
  const ok = broken === 0 && a.length > 0 && zcr < 0.4 && rms > 0.003 && rms < 0.5 && peak < 1.2;
  return { ok, zcr: +zcr.toFixed(3), rms: +rms.toFixed(4), peak: +peak.toFixed(3), samples: a.length };
}

async function load(preferCpu: boolean): Promise<void> {
  if (tts || loading) return;
  loading = true;
  try {
    let device = preferCpu ? 'wasm' : await pickDevice();
    let note = '';
    let gpuCheck: Check | null = null;
    port.postMessage({ type: 'device', device });

    // The CPU model (8-bit, ~90 MB) is always loaded: it's the voice engine on the CPU, and the
    // reference the GPU voice is compared against.
    const cpu = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback: device === 'wasm' ? progress : undefined });
    const cpuCheck = await speakCheck(cpu);

    if (device === 'webgpu') {
      try {
        // On the GPU the library recommends full precision (~330 MB).
        const gpu = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device, progress_callback: progress });
        gpuCheck = await speakCheck(gpu);
        if (sameVoice(gpuCheck, cpuCheck)) tts = gpu;
        else {
          note = 'the GPU voice came out as static in this browser';
          console.warn('Voices: GPU output failed the check against the CPU voice', { gpu: gpuCheck, cpu: cpuCheck });
        }
      } catch (e) {
        note = 'the GPU voice failed to load in this browser';
        console.warn('Voices: GPU model failed to load', e);
      }
      if (!tts) {
        console.warn(`Voices: ${note}; using the CPU instead.`);
        device = 'wasm';
        port.postMessage({ type: 'device', device });
      }
    }
    tts ??= cpu;
    port.postMessage({ type: 'ready', device, note, check: { cpu: cpuCheck, gpu: gpuCheck } });
    void work();
  } catch (e) {
    port.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    loading = false;
  }
}

async function work(): Promise<void> {
  if (working || !tts) return;
  working = true;
  while (jobs.length > 0) {
    const job = jobs.shift()!;
    if (job.gen !== generation) continue;
    try {
      // A closed splitter: given a plain string, kokoro-js leaves its splitter open and
      // waits forever after the last full sentence.
      const sentences = new TextSplitterStream();
      sentences.push(job.text);
      sentences.close();
      for await (const part of tts.stream(sentences, { voice: job.voice as never, speed: job.speed })) {
        if (job.gen !== generation) break;
        const audio = new Float32Array(part.audio.audio); // own buffer, so it can be transferred
        port.postMessage({ type: 'chunk', id: job.id, text: part.text, audio, rate: part.audio.sampling_rate }, [audio.buffer]);
      }
    } catch (e) {
      console.warn('Could not speak a line:', e);
    }
    port.postMessage({ type: 'done', id: job.id });
  }
  working = false;
}

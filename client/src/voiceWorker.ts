/**
 * Background thread for text-to-speech, so generating speech never freezes the game.
 *
 * Messages in:  { type: 'load' } | { type: 'speak', id, text, voice, speed } | { type: 'cancel' }
 * Messages out: { type: 'progress', progress } | { type: 'ready' } | { type: 'error', message }
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
  const msg = e.data as { type: string } & Partial<Job>;
  if (msg.type === 'load') void load();
  if (msg.type === 'speak') {
    jobs.push({ id: msg.id!, text: msg.text!, voice: msg.voice!, speed: msg.speed ?? 1, gen: generation });
    void work();
  }
  if (msg.type === 'cancel') {
    generation++;
    jobs.length = 0;
  }
};

async function load(): Promise<void> {
  if (tts || loading) return;
  loading = true;
  try {
    tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: unknown) => {
        const info = p as { status?: string; file?: string; progress?: number };
        if (info.status === 'progress' && info.file?.endsWith('.onnx') && typeof info.progress === 'number') {
          port.postMessage({ type: 'progress', progress: Math.round(info.progress) });
        }
      },
    });
    port.postMessage({ type: 'ready' });
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

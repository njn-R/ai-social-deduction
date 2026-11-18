import { TICK_RATE } from '../../engine';
import type { LlmProvider, LlmRequest, LlmResult } from './types';

/** Lower number = served first. */
export const PRIORITY = { vote: 0, meeting: 1, urgent: 2, plan: 3 } as const;

export interface LlmJob {
  /** Short tag for logs and stats, e.g. "vote:hale". */
  label: string;
  priority: number;
  /** Builds the request when the call actually starts, so it sees the freshest state. */
  build: () => LlmRequest;
  /** Checked just before the call starts; return false to drop a job that's gone stale. */
  stillWanted?: () => boolean;
  onDone: (result: LlmResult) => void;
  onError: (error: Error) => void;
}

interface Pending extends LlmJob {
  seq: number;
  submitTick: number;
}

interface InFlight {
  job: Pending;
  startTick: number;
  settled: boolean;
  dueTick: number;
  result?: LlmResult;
  error?: Error;
  promise: Promise<void>;
}

export interface QueueStats {
  calls: number;
  errors: number;
  dropped: number;
  latenciesMs: number[];
  waitTicks: number[];
  promptTokens: number;
  maxPromptTokens: number;
  completionTokens: number;
}

/**
 * Every AI call goes through one of these, so the local GPU is never asked for more than
 * `concurrency` answers at once, and urgent work (votes, meeting talk) jumps the line.
 *
 * Two clock modes:
 * - `realtime`: the game runs on the wall clock; answers are handed over on the next tick
 *   after they arrive. For live play.
 * - `virtual`: the game runs as fast as it can, but a call that took N ms of wall time is
 *   handed over N ms of *game* time after it started, and the game waits for the model when
 *   it has to. AI-only games then play exactly as they would live, minus the idle waiting.
 */
export class LlmQueue {
  readonly stats: QueueStats = { calls: 0, errors: 0, dropped: 0, latenciesMs: [], waitTicks: [], promptTokens: 0, maxPromptTokens: 0, completionTokens: 0 };
  private readonly pending: Pending[] = [];
  private readonly inFlight: InFlight[] = [];
  private seq = 0;
  private tick = 0;

  constructor(
    private readonly provider: LlmProvider,
    private readonly opts: { concurrency: number; mode: 'virtual' | 'realtime' },
  ) {
    if (opts.concurrency < 1) throw new Error('concurrency must be at least 1');
  }

  get idle(): boolean {
    return this.pending.length === 0 && this.inFlight.length === 0;
  }

  /** Number of queued or running jobs whose label starts with `prefix`. */
  count(prefix = ''): number {
    return (
      this.pending.filter((j) => j.label.startsWith(prefix)).length +
      this.inFlight.filter((f) => f.job.label.startsWith(prefix)).length
    );
  }

  submit(job: LlmJob): void {
    this.pending.push({ ...job, seq: this.seq++, submitTick: this.tick });
  }

  /**
   * Call once per tick, before controllers act: hands over answers that are due, starts
   * queued calls in free slots, and (virtual mode) waits for the model when the game would
   * otherwise get ahead of it.
   */
  async sync(tick: number): Promise<void> {
    this.tick = tick;
    for (;;) {
      this.deliverDue(tick);
      this.startJobs(tick);
      if (this.opts.mode === 'virtual') {
        const blocking = this.inFlight.find((f) => !f.settled && f.startTick < tick);
        if (blocking) {
          await blocking.promise;
          continue;
        }
      }
      return;
    }
  }

  /** Wait for running calls to finish and discard their results (used at game end). */
  async drain(): Promise<void> {
    this.pending.length = 0;
    await Promise.all(this.inFlight.map((f) => f.promise));
    this.inFlight.length = 0;
  }

  private deliverDue(tick: number): void {
    const due = this.inFlight
      .filter((f) => f.settled && f.dueTick <= tick)
      .sort((a, b) => a.dueTick - b.dueTick || a.job.seq - b.job.seq);
    for (const f of due) {
      this.inFlight.splice(this.inFlight.indexOf(f), 1);
      if (f.result) f.job.onDone(f.result);
      else f.job.onError(f.error ?? new Error('LLM call failed'));
    }
  }

  private startJobs(tick: number): void {
    while (this.inFlight.length < this.opts.concurrency && this.pending.length > 0) {
      let best = 0;
      for (let i = 1; i < this.pending.length; i++) {
        const a = this.pending[i];
        const b = this.pending[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const job = this.pending.splice(best, 1)[0];
      if (job.stillWanted && !job.stillWanted()) {
        this.stats.dropped++;
        continue;
      }
      this.start(job, tick);
    }
  }

  private start(job: Pending, tick: number): void {
    const wallStart = performance.now();
    this.stats.calls++;
    this.stats.waitTicks.push(tick - job.submitTick);
    const f: InFlight = { job, startTick: tick, settled: false, dueTick: Infinity, promise: Promise.resolve() };
    let request: Promise<LlmResult>;
    try {
      request = this.provider.complete(job.build());
    } catch (e) {
      request = Promise.reject(e);
    }
    f.promise = request.then(
      (r) => {
        f.result = r;
        this.stats.latenciesMs.push(r.latencyMs);
        this.stats.promptTokens += r.promptTokens ?? 0;
        this.stats.maxPromptTokens = Math.max(this.stats.maxPromptTokens, r.promptTokens ?? 0);
        this.stats.completionTokens += r.completionTokens ?? 0;
        this.settle(f, r.latencyMs);
      },
      (e: unknown) => {
        f.error = e instanceof Error ? e : new Error(String(e));
        this.stats.errors++;
        this.settle(f, performance.now() - wallStart);
      },
    );
    this.inFlight.push(f);
  }

  private settle(f: InFlight, latencyMs: number): void {
    f.settled = true;
    f.dueTick = this.opts.mode === 'virtual' ? f.startTick + Math.max(1, Math.ceil((latencyMs * TICK_RATE) / 1000)) : -Infinity;
  }
}

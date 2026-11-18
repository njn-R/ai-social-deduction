import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/ai/llm/fake';
import { LlmQueue, PRIORITY, type LlmJob } from '../../src/ai/llm/queue';
import type { LlmRequest } from '../../src/ai/llm/types';

const req = (label: string): LlmRequest => ({
  label,
  system: '',
  prompt: '',
  schema: { name: 'x', schema: { type: 'object', properties: { a: { type: 'string', enum: ['y'] } } } },
  maxTokens: 10,
});

function job(label: string, extra: Partial<LlmJob> = {}): LlmJob {
  return { label, priority: PRIORITY.meeting, build: () => req(label), onDone: () => {}, onError: () => {}, ...extra };
}

async function run(q: LlmQueue, ticks: number): Promise<void> {
  for (let t = 0; t < ticks; t++) await q.sync(t);
}

describe('LlmQueue', () => {
  it('hands an answer over exactly as much game time after the call started as the call took', async () => {
    const q = new LlmQueue(new FakeProvider({ latencyMs: 1000 }), { concurrency: 1, mode: 'virtual' });
    let doneAt = -1;
    let tick = 0;
    q.submit(job('a', { onDone: () => (doneAt = tick) }));
    for (tick = 0; tick < 40; tick++) await q.sync(tick);
    expect(doneAt).toBe(20); // started at tick 0; 1000 ms = 20 ticks
  });

  it('serves votes before meeting lines before round plans', async () => {
    const order: string[] = [];
    const q = new LlmQueue(new FakeProvider({ latencyMs: 50 }), { concurrency: 1, mode: 'virtual' });
    q.submit(job('plan', { priority: PRIORITY.plan, onDone: () => order.push('plan') }));
    q.submit(job('turn', { priority: PRIORITY.meeting, onDone: () => order.push('turn') }));
    q.submit(job('vote', { priority: PRIORITY.vote, onDone: () => order.push('vote') }));
    await run(q, 20);
    expect(order).toEqual(['vote', 'turn', 'plan']);
  });

  it('runs several calls side by side when concurrency allows', async () => {
    const q = new LlmQueue(new FakeProvider({ latencyMs: 1000 }), { concurrency: 3, mode: 'virtual' });
    const doneAt: number[] = [];
    let tick = 0;
    for (const l of ['a', 'b', 'c']) q.submit(job(l, { onDone: () => doneAt.push(tick) }));
    for (tick = 0; tick < 50; tick++) await q.sync(tick);
    expect(doneAt).toEqual([20, 20, 20]);
  });

  it('drops a job that went stale while waiting', async () => {
    let wanted = true;
    let called = false;
    const q = new LlmQueue(new FakeProvider({ latencyMs: 100 }), { concurrency: 1, mode: 'virtual' });
    q.submit(job('first'));
    q.submit(job('stale', { stillWanted: () => wanted, onDone: () => (called = true) }));
    wanted = false;
    await run(q, 20);
    expect(called).toBe(false);
    expect(q.stats.dropped).toBe(1);
  });

  it('builds the request only when the call starts', async () => {
    let builtAt = -1;
    let tick = 0;
    const q = new LlmQueue(new FakeProvider({ latencyMs: 500 }), { concurrency: 1, mode: 'virtual' });
    q.submit(job('first'));
    q.submit(job('second', { build: () => ((builtAt = tick), req('second')) }));
    for (tick = 0; tick < 30; tick++) await q.sync(tick);
    expect(builtAt).toBe(10); // after the first call's 500 ms
  });

  it('reports failures through onError', async () => {
    const q = new LlmQueue(
      new FakeProvider({
        respond: () => {
          throw new Error('boom');
        },
      }),
      { concurrency: 1, mode: 'virtual' },
    );
    let error = '';
    q.submit(job('a', { onError: (e) => (error = e.message) }));
    await run(q, 5);
    expect(error).toBe('boom');
    expect(q.stats.errors).toBe(1);
  });
});

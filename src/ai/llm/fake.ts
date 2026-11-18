import { Rng } from '../../engine';
import type { JsonSchema, LlmProvider, LlmRequest, LlmResult } from './types';

export interface FakeOptions {
  seed?: number;
  /** Pretend each call took this long (drives game-time accounting in virtual mode). */
  latencyMs?: number;
  /** Override the reply for a request; return undefined to use the default schema filler. */
  respond?: (req: LlmRequest) => unknown;
}

/**
 * Deterministic stand-in for a real model, for tests and quick dry runs.
 * By default it fills the schema: picks enum values at random (seeded) and
 * writes stock text for strings.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  private readonly rng: Rng;

  constructor(private readonly opts: FakeOptions = {}) {
    this.rng = new Rng(opts.seed ?? 1);
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    const json = this.opts.respond?.(req) ?? this.fill(req.schema.schema, '');
    return { json, raw: JSON.stringify(json), latencyMs: this.opts.latencyMs ?? 2500, model: 'fake' };
  }

  private fill(schema: JsonSchema, key: string): unknown {
    const e = schema.enum as unknown[] | undefined;
    if (e && e.length > 0) return e[this.rng.int(e.length)];
    switch (schema.type) {
      case 'object': {
        const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
        return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, this.fill(v, k)]));
      }
      case 'array': {
        const items = schema.items as JsonSchema | undefined;
        return items && this.rng.chance(0.5) ? [this.fill(items, key)] : [];
      }
      case 'integer':
      case 'number':
        return typeof schema.minimum === 'number' ? schema.minimum : 0;
      case 'boolean':
        return this.rng.chance(0.5);
      case 'string':
        return STOCK[key] ?? '';
      default:
        return null;
    }
  }
}

const STOCK: Record<string, string> = {
  thoughts: 'Weighing what I saw against what people are saying.',
  say: 'I was doing my tasks. Did anyone see anything?',
  at: '',
  reason: 'Going with my gut.',
};

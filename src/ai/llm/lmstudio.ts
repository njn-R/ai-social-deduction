import { parseJsonLoose } from './json';
import type { LlmProvider, LlmRequest, LlmResult } from './types';

export interface LmStudioOptions {
  /** Server root, default http://localhost:1234 */
  baseUrl?: string;
  /** Model id. Omit to use whichever model LM Studio has loaded (see `resolveModel`). */
  model?: string;
  timeoutMs?: number;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The model produced no answer text, usually because hidden reasoning used up the budget. */
class EmptyReply extends Error {
  constructor(
    readonly latencyMs: number,
    readonly reasoning: string | undefined,
  ) {
    super('LM Studio returned an empty reply (reply budget used up by reasoning?)');
  }
}

interface ModelInfo {
  id: string;
  type?: string;
  state?: string;
}

/** Talks to LM Studio's OpenAI-compatible server with JSON-schema structured output. */
export class LmStudioProvider implements LlmProvider {
  readonly name = 'lmstudio';
  private readonly root: string;
  private model: string | null;
  private readonly timeoutMs: number;

  constructor(opts: LmStudioOptions = {}) {
    this.root = (opts.baseUrl ?? 'http://localhost:1234').replace(/\/+$/, '').replace(/\/v1$/, '');
    this.model = opts.model ?? null;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  get modelId(): string | null {
    return this.model;
  }

  /** Models LM Studio knows about, with load state. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.root}/api/v0/models`, { signal: AbortSignal.timeout(10_000) }).catch((e: unknown) => {
      throw new Error(`Can't reach LM Studio at ${this.root} (${String(e)}). Start it with: lms server start`);
    });
    if (!res.ok) throw new Error(`LM Studio /api/v0/models returned ${res.status}`);
    const body = (await res.json()) as { data?: ModelInfo[] };
    return body.data ?? [];
  }

  /** Pick the configured model, or else the first loaded text model. */
  async resolveModel(): Promise<string> {
    if (this.model) return this.model;
    const loaded = (await this.listModels()).filter((m) => m.state === 'loaded' && (m.type === 'llm' || m.type === 'vlm'));
    if (loaded.length === 0) throw new Error('No model is loaded in LM Studio. Load one with: lms load <model>');
    this.model = loaded[0].id;
    return this.model;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    try {
      return await this.reliably(req);
    } catch (e) {
      // Hidden reasoning can eat the whole reply budget. Answer again without it.
      if (!(e instanceof EmptyReply) || (req.reasoning ?? 'none') === 'none') throw e;
      const retry = await this.reliably({ ...req, reasoning: 'none' });
      return { ...retry, latencyMs: e.latencyMs + retry.latencyMs, reasoning: e.reasoning ?? retry.reasoning };
    }
  }

  /** One call, retried once if the connection drops (seen right after a model loads). */
  private async reliably(req: LlmRequest): Promise<LlmResult> {
    const started = performance.now();
    try {
      return await this.once(req);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // fetch() network failures are TypeErrors
      await new Promise((r) => setTimeout(r, 500));
      const retry = await this.once(req);
      return { ...retry, latencyMs: performance.now() - started };
    }
  }

  private async once(req: LlmRequest): Promise<LlmResult> {
    const model = await this.resolveModel();
    const started = performance.now();
    const res = await fetch(`${this.root}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        temperature: req.temperature ?? 0.8,
        max_tokens: req.maxTokens,
        reasoning_effort: req.reasoning ?? 'none',
        response_format: { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } },
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as ChatCompletion;
    const latencyMs = performance.now() - started;
    const message = body.choices?.[0]?.message;
    const raw = message?.content ?? '';
    if (!raw.trim()) throw new EmptyReply(latencyMs, message?.reasoning_content ?? undefined);
    return {
      json: parseJsonLoose(raw),
      raw,
      reasoning: message?.reasoning_content ?? undefined,
      latencyMs,
      promptTokens: body.usage?.prompt_tokens,
      completionTokens: body.usage?.completion_tokens,
      model: body.model ?? model,
    };
  }
}

export type JsonSchema = Record<string, unknown>;

/** How much hidden reasoning the model may do before answering. */
export type Reasoning = 'none' | 'low' | 'medium';

export interface LlmRequest {
  /** Short tag for logs and stats, e.g. "meeting:hale". */
  label: string;
  system: string;
  prompt: string;
  /** The reply is forced to match this JSON schema. */
  schema: { name: string; schema: JsonSchema };
  maxTokens: number;
  temperature?: number;
  reasoning?: Reasoning;
}

export interface LlmResult {
  json: unknown;
  raw: string;
  /** Hidden reasoning, when the model returns it (shown in the post-game reveal). */
  reasoning?: string;
  /** Wall time, or a simulated time for the fake provider. Drives game-time accounting. */
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

/**
 * Checks the local model: is LM Studio reachable, which model is loaded, how fast is one
 * short structured call, and how fast are several at once.
 *
 *   npm run llm:check
 *   npm run llm:check -- --model <id> --parallel 4
 */
import { parseArgs } from 'node:util';
import { LmStudioProvider } from './llm/lmstudio';
import type { LlmRequest } from './llm/types';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    url: { type: 'string' },
    parallel: { type: 'string', default: '4' },
  },
});

const provider = new LmStudioProvider({ model: values.model, baseUrl: values.url });
const model = await provider.resolveModel();
console.log(`LM Studio is up. Using model: ${model}`);

const request = (who: string): LlmRequest => ({
  label: `check:${who}`,
  system: 'You are a player in a social-deduction game aboard an underwater research station. Reply only with JSON.',
  prompt: `You are ${who}, a nervous crew member. Jinx just found Mo's body in the Galley. You were in Sonar. Say one short line to the group.`,
  schema: {
    name: 'turn',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thoughts: { type: 'string', maxLength: 160 },
        say: { type: 'string', maxLength: 140 },
        accuse: { type: 'string', enum: ['Jinx', 'nobody'] },
      },
      required: ['thoughts', 'say', 'accuse'],
    },
  },
  maxTokens: 200,
  temperature: 0.8,
});

const one = await provider.complete(request('Pip'));
const rate = (one.completionTokens ?? 0) / (one.latencyMs / 1000);
console.log(`\nOne call: ${(one.latencyMs / 1000).toFixed(2)}s, ${one.promptTokens} prompt + ${one.completionTokens} reply tokens (~${rate.toFixed(0)} tokens/s)`);
console.log(`  ${one.raw}`);
const say = (one.json as { say?: string }).say ?? '';
console.log(`  "say" length ${say.length} (schema max 140)`);

const n = Number(values.parallel);
const started = performance.now();
const many = await Promise.all(Array.from({ length: n }, (_, i) => provider.complete(request(`Crew${i + 1}`))));
const wall = (performance.now() - started) / 1000;
const each = many.map((r) => (r.latencyMs / 1000).toFixed(2)).join(', ');
console.log(`\n${n} calls at once: ${wall.toFixed(2)}s total (each: ${each}s) -> ${(n / wall).toFixed(2)} calls/s vs ${(1000 / one.latencyMs).toFixed(2)} calls/s one at a time`);

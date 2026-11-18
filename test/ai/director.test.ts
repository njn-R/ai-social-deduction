import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/ai/llm/fake';
import type { LlmRequest } from '../../src/ai/llm/types';
import { runAiGame } from '../../src/ai/runAiGame';

/** Every meeting line accuses the first name the schema allows. */
function accuser(req: LlmRequest): unknown {
  if (req.schema.name !== 'meeting_turn') return undefined;
  const props = req.schema.schema.properties as Record<string, { enum?: string[] }>;
  const target = props.accuse.enum![0];
  return { thoughts: 'pointing fingers', intent: 'accuse', say: `I think ${target} did it.`, accuse: target, claims: [] };
}

describe('MeetingDirector', () => {
  it('gives the floor to whoever was just accused, and tells them so', async () => {
    const fake = new FakeProvider({ seed: 1, respond: accuser });
    const r = await runAiGame({ seed: 1, provider: fake });
    const chats = r.game.events.filter((e) => e.type === 'chat');
    expect(chats.length).toBeGreaterThan(2);

    const turns = fake.requests.filter((q) => q.schema.name === 'meeting_turn');
    const answers = turns.filter((q) => q.prompt.includes('just accused you. Respond.'));
    expect(answers.length).toBeGreaterThan(0);
    for (const q of answers) {
      const speaker = q.label.split(':')[1];
      // The line right before this prompt was built must have accused this speaker.
      const before = chats.filter((c) => q.prompt.includes(c.text));
      expect(before.some((c) => c.accuse === speaker)).toBe(true);
    }
  }, 60_000);

  it('lets the person who called the meeting speak first', async () => {
    const speaks = (req: LlmRequest) =>
      req.schema.name === 'meeting_turn' ? { thoughts: '', intent: 'share_info', say: 'Here is what I know.', accuse: 'nobody', claims: [] } : undefined;
    const fake = new FakeProvider({ seed: 1, respond: speaks });
    const r = await runAiGame({ seed: 1, provider: fake });
    const called = r.game.events.find((e) => e.type === 'meeting_called')!;
    const firstLine = r.game.events.find((e) => e.type === 'chat')!;
    expect(called.type === 'meeting_called' && firstLine.type === 'chat' && firstLine.playerId === called.callerId).toBe(true);
  }, 60_000);
});

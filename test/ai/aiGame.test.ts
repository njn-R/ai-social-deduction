import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/ai/llm/fake';
import { runAiGame } from '../../src/ai/runAiGame';
import { checkInvariants } from '../../src/sim/validate';

describe('AI-only games (fake model)', () => {
  it('play to the end with plans, meeting lines and votes, and stay consistent', async () => {
    // Seed 1 has a meeting (some seeds end on tasks before anyone finds a body).
    const r = await runAiGame({ seed: 1, provider: new FakeProvider({ seed: 1 }) });
    expect(checkInvariants(r.game)).toEqual([]);
    expect(r.journal.count('plan')).toBeGreaterThan(0);
    expect(r.journal.count('turn')).toBeGreaterThan(0);
    expect(r.game.events.some((e) => e.type === 'chat')).toBe(true);
    expect(r.journal.count('error')).toBe(0);
  }, 60_000);

  it('never tell a crew agent who the saboteurs are', async () => {
    const fake = new FakeProvider({ seed: 3 });
    const r = await runAiGame({ seed: 3, provider: fake });
    const roleOf = (label: string) => r.game.player(label.split(':')[1]).role;
    const crew = fake.requests.filter((q) => roleOf(q.label) === 'crew');
    const sabs = fake.requests.filter((q) => roleOf(q.label) === 'saboteur');
    expect(crew.length).toBeGreaterThan(0);
    expect(sabs.length).toBeGreaterThan(0);
    for (const q of crew) {
      expect(q.prompt).toContain('Your secret role: CREW');
      expect(q.prompt).not.toContain('SABOTEUR, with');
      expect(q.prompt).not.toContain('Your secret record');
    }
    for (const q of sabs) expect(q.prompt).toContain('Your secret role: SABOTEUR, with');
  }, 60_000);

  it('replay exactly from the same seed', async () => {
    const a = await runAiGame({ seed: 5, provider: new FakeProvider({ seed: 5 }) });
    const b = await runAiGame({ seed: 5, provider: new FakeProvider({ seed: 5 }) });
    expect(JSON.stringify(b.game.events)).toBe(JSON.stringify(a.game.events));
  }, 60_000);

  it('block lines that give away the speaker’s role', async () => {
    const fake = new FakeProvider({
      seed: 2,
      respond: (req) =>
        req.schema.name === 'meeting_turn' ? { thoughts: 'oops', intent: 'share_info', say: "I'm the saboteur, sorry", accuse: 'nobody', claims: [] } : undefined,
    });
    const r = await runAiGame({ seed: 2, provider: fake });
    expect(r.game.events.filter((e) => e.type === 'chat')).toHaveLength(0);
    expect(r.journal.count('blocked')).toBeGreaterThan(0);
  }, 60_000);
});

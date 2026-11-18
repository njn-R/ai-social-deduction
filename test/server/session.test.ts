import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/ai/llm/fake';
import { dist, secToTicks } from '../../src/engine';
import { parseHumanChat } from '../../src/server/humanChat';
import { cleanName, GameSession, HUMAN_ID, type SessionOptions } from '../../src/server/session';
import type { ServerMessage } from '../../src/shared/protocol';

function session(extra: Partial<SessionOptions> = {}) {
  const sent: ServerMessage[] = [];
  const s = new GameSession({
    provider: new FakeProvider({ seed: 1 }),
    model: 'fake',
    humanName: 'Sam',
    role: 'crew',
    seed: 11,
    mode: 'virtual',
    outDir: null,
    send: (m) => sent.push(m),
    ...extra,
  });
  return { s, sent };
}

async function ticks(s: GameSession, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await s.step();
}

describe('GameSession', () => {
  it('seats the human with 8 AIs and gives them the role they asked for', () => {
    const { s } = session({ role: 'saboteur' });
    expect(s.game.players).toHaveLength(9);
    expect(s.game.player(HUMAN_ID)).toMatchObject({ name: 'Sam', role: 'saboteur' });
    expect(s.table.agents).toHaveLength(8);
    expect(s.welcome()).toMatchObject({ type: 'welcome', you: HUMAN_ID });
  });

  it('sends only the human’s own view, never who the saboteurs are', async () => {
    const { s, sent } = session({ role: 'crew' });
    await ticks(s, 200);
    const views = sent.filter((m) => m.type === 'obs');
    expect(views.length).toBe(200);
    for (const m of views) {
      if (m.type !== 'obs') continue;
      expect(m.obs.self.id).toBe(HUMAN_ID);
      expect(m.obs.saboteurTeam).toEqual([]);
      expect(JSON.stringify(m.obs.roster)).not.toContain('saboteur');
    }
  });

  it('moves the human from keyboard input', async () => {
    const { s } = session();
    const before = { ...s.game.player(HUMAN_ID).pos };
    s.handle({ type: 'move', dir: { x: 1, y: 0 } });
    await ticks(s, 10);
    s.handle({ type: 'move', dir: null });
    await ticks(s, 5);
    const after = s.game.player(HUMAN_ID).pos;
    expect(dist(before, after)).toBeGreaterThan(1);
  });

  it('runs actions through the engine and reports rejections', async () => {
    const { s, sent } = session();
    const task = s.game.player(HUMAN_ID).tasks[0];
    s.handle({ type: 'act', action: { type: 'start_task', stationId: task.stationId } });
    expect(sent.at(-1)).toEqual({ type: 'notice', text: 'too far from the task' });
    s.game.player(HUMAN_ID).pos = { ...s.game.nav.station(task.stationId).pos };
    s.handle({ type: 'act', action: { type: 'start_task', stationId: task.stationId } });
    expect(s.game.player(HUMAN_ID).busy).not.toBeNull();
  });

  it('posts meeting chat with the accusation read out of it', async () => {
    const { s } = session();
    await ticks(s, secToTicks(16)); // past the emergency button cooldown
    s.game.player(HUMAN_ID).pos = { ...s.game.map.button.pos };
    s.handle({ type: 'act', action: { type: 'call_meeting' } });
    expect(s.game.phase).toBe('meeting');
    const target = s.game.players.find((p) => p.id !== HUMAN_ID)!;
    s.handle({ type: 'chat', text: `${target.name} is acting really sus` });
    expect(s.game.state.meeting!.chat.at(-1)).toMatchObject({ playerId: HUMAN_ID, accuse: target.id });
  });
});

describe('meeting pacing with a human at the table', () => {
  /** Start a session and have the human press the emergency button. */
  async function meetingWith(provider: FakeProvider) {
    const { s, sent } = session({ provider });
    await ticks(s, secToTicks(16));
    s.game.player(HUMAN_ID).pos = { ...s.game.map.button.pos };
    s.handle({ type: 'act', action: { type: 'call_meeting' } });
    expect(s.game.phase).toBe('meeting');
    return { s, sent, chat: () => s.game.state.meeting?.chat ?? [] };
  }

  it('leaves time to read each line before the next one', async () => {
    const { s, chat } = await meetingWith(new FakeProvider({ seed: 2, latencyMs: 500, respond: (r) => (r.schema.name === 'meeting_turn' ? speak('A line long enough to need a moment to read it through.') : undefined) }));
    await ticks(s, secToTicks(60));
    const lines = chat();
    expect(lines.length).toBeGreaterThan(3);
    for (let i = 1; i < lines.length; i++) {
      const pause = Math.min(10, 3.5 + lines[i - 1].text.length / 20);
      expect(lines[i].tick - lines[i - 1].tick).toBeGreaterThanOrEqual(secToTicks(pause));
    }
  });

  it('holds AI lines while the human is typing (up to 20 s)', async () => {
    const { s, chat } = await meetingWith(new FakeProvider({ seed: 2, latencyMs: 500, respond: (r) => (r.schema.name === 'meeting_turn' ? speak('Hm.') : undefined) }));
    for (let i = 0; i < secToTicks(15); i++) {
      s.handle({ type: 'typing' });
      await s.step();
    }
    expect(chat()).toEqual([]);
    for (let i = 0; i < secToTicks(8); i++) {
      s.handle({ type: 'typing' });
      await s.step();
    }
    expect(chat().length).toBeGreaterThan(0); // a typing human can't stall the meeting forever
  });

  it('holds the next AI line while the browser is still reading one aloud', async () => {
    const { s, chat } = await meetingWith(new FakeProvider({ seed: 2, latencyMs: 500, respond: (r) => (r.schema.name === 'meeting_turn' ? speak('Hm.') : undefined) }));
    while (chat().length === 0) await s.step();
    s.handle({ type: 'speaking', on: true }); // the browser starts reading the first line
    await ticks(s, secToTicks(12));
    expect(chat().length).toBe(1);
    s.handle({ type: 'speaking', on: false });
    await ticks(s, secToTicks(2));
    expect(chat().length).toBe(2);
  });

  it('tells the browser how each AI sounds', () => {
    const { s } = session();
    const w = s.welcome();
    expect(w.type === 'welcome' && Object.keys(w.voices).sort()).toEqual(s.table.agents.map((a) => a.id).sort());
    expect(w.type === 'welcome' && w.voices[s.table.agents[0].id]).toMatchObject({ kokoro: expect.any(String), speed: expect.any(Number) });
  });

  it('throws away a line written before the human spoke, and writes a fresh one', async () => {
    let n = 0;
    const heardHuman = new Map<string, boolean>();
    const provider = new FakeProvider({
      seed: 2,
      latencyMs: 3000,
      respond: (r) => {
        if (r.schema.name !== 'meeting_turn') return undefined;
        const say = `line ${++n}`;
        heardHuman.set(say, r.prompt.includes('Where was everyone?'));
        return speak(say);
      },
    });
    const { s, chat } = await meetingWith(provider);
    await ticks(s, 3); // the first AI line is being written now
    s.handle({ type: 'chat', text: 'Where was everyone?' });
    await ticks(s, secToTicks(20));
    const ai = chat().filter((c) => c.playerId !== HUMAN_ID);
    expect(ai.length).toBeGreaterThan(0);
    expect(heardHuman.get(ai[0].text)).toBe(true);
    expect(n).toBeGreaterThan(ai.length); // at least one line was discarded
  });
});

function speak(say: string) {
  return { thoughts: '', intent: 'share_info', say, accuse: 'nobody', claims: [] };
}

describe('parseHumanChat', () => {
  const { s } = session();
  const g = s.game;
  const other = g.players.find((p) => p.id !== HUMAN_ID)!;

  it('finds accusations, but not defences', () => {
    expect(parseHumanChat(`I think ${other.name} did it`, g, HUMAN_ID).accuse).toBe(other.id);
    expect(parseHumanChat(`${other.name} is not sus, they were with me`, g, HUMAN_ID).accuse).toBeUndefined();
    expect(parseHumanChat('hello everyone', g, HUMAN_ID)).toEqual({});
  });

  it('reads where the speaker says they were', () => {
    const c = parseHumanChat(`I was in the Galley with ${other.name}`, g, HUMAN_ID).claims;
    expect(c).toEqual([{ areaId: 'galley', atTick: null, saw: [other.id] }]);
  });
});

describe('cleanName', () => {
  it('keeps names short and plain, and never the same as an AI', () => {
    expect(cleanName('  Sam<script>  ')).toBe('Samscript');
    expect(cleanName('')).toBe('Player');
    expect(cleanName('Hale')).toBe('Hale 2');
    expect(cleanName('a very very long name here')).toHaveLength(14);
  });
});

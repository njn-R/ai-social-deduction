import { describe, expect, it } from 'vitest';
import { Memory, TABLE_SEC } from '../../src/ai/memory';
import { buildNotes } from '../../src/ai/notebook';
import { TIERS } from '../../src/ai/tiers';
import { Rng, type Game } from '../../src/engine';
import { makeGame, openVoting, place, stepSec } from '../helpers';

const FAR = { lab: { x: 55.5, y: 7.5 }, generator: { x: 8.5, y: 38.5 }, ballast: { x: 55.5, y: 38.5 } };

/**
 * p1 watches from Commons; everyone else starts far away. Skips the first seconds of the
 * round, when everyone is still at the table and memory deliberately records nothing.
 */
function scene(): Game {
  const g = makeGame();
  stepSec(g, TABLE_SEC + 1);
  place(g, 'p0', FAR.lab);
  place(g, 'p1', { x: 31.5, y: 18.5 });
  place(g, 'p2', { x: 33.5, y: 18.5 });
  place(g, 'p3', FAR.generator);
  place(g, 'p4', FAR.ballast);
  return g;
}

describe('Memory', () => {
  it('records who it saw and where, one entry per area', () => {
    const g = scene();
    const mem = new Memory('p1', TIERS.sharp, new Rng(1));
    mem.observe(g.observe('p1'));
    stepSec(g, 1);
    mem.observe(g.observe('p1'));
    place(g, 'p2', { x: 31.5, y: 14.5 }); // into the corridor towards Sonar, still in view
    stepSec(g, 1);
    mem.observe(g.observe('p1'));

    expect(mem.sightings.map((s) => [s.playerId, s.areaId])).toEqual([
      ['p2', 'commons'],
      ['p2', 'hall-sonar-commons'],
    ]);
    expect(mem.sightings[0].to - mem.sightings[0].from).toBe(20);
  });

  it('lets rookies miss people and mix them up', () => {
    const g = scene();
    const mem = new Memory('p1', TIERS.rookie, new Rng(7));
    for (let i = 0; i < 200; i++) {
      place(g, 'p2', { x: 33.5, y: 18.5 });
      mem.observe(g.observe('p1'));
      place(g, 'p2', FAR.lab);
      mem.observe(g.observe('p1'));
    }
    const noticed = mem.sightings.length;
    expect(noticed).toBeGreaterThan(110);
    expect(noticed).toBeLessThan(170);
    expect(mem.sightings.some((s) => s.playerId !== 'p2')).toBe(true);
  });

  it('notices a kill that happens in front of it', () => {
    const g = scene();
    place(g, 'p0', { x: 32.5, y: 20.5 });
    place(g, 'p2', { x: 33.5, y: 20.5 });
    const mem = new Memory('p1', TIERS.sharp, new Rng(1));
    mem.observe(g.observe('p1'));
    expect(g.act('p0', { type: 'kill', targetId: 'p2' }).ok).toBe(true);
    mem.observe(g.observe('p1'));
    expect(mem.bodies).toMatchObject([{ victimId: 'p2', killer: 'p0', areaId: 'commons' }]);
  });
});

describe('notebook', () => {
  /** p1 sees p2 in Commons, then p2 claims to have been in Sonar at that moment. */
  function liar(tier: keyof typeof TIERS): string {
    const g = scene();
    const mem = new Memory('p1', TIERS[tier], new Rng(3));
    mem.observe(g.observe('p1'));
    const sawAt = g.tick;
    stepSec(g, 1);
    mem.observe(g.observe('p1'));
    openVoting(g, 'p3');
    mem.observe(g.observe('p1'));
    expect(g.act('p2', { type: 'chat', text: 'I was in Sonar the whole time.', claims: [{ areaId: 'sonar', atTick: sawAt, saw: [] }] }).ok).toBe(true);
    const obs = g.observe('p1');
    mem.observe(obs);
    return buildNotes({ obs, memory: mem, tier: TIERS[tier], nav: g.nav, config: g.config, name: (id) => g.player(id).name });
  }

  it('flags a claim that clashes with what a sharp player saw', () => {
    const notes = liar('sharp');
    expect(notes).toMatch(/P2 says they were in Sonar at 0:0\d\. CONFLICT: you saw them in Commons/);
  });

  it('ignores who was at the table when the round began', () => {
    const g = makeGame();
    const mem = new Memory('p1', TIERS.sharp, new Rng(1));
    for (let i = 0; i < TABLE_SEC * 20 - 5; i++) {
      mem.observe(g.observe('p1'));
      g.step();
    }
    expect(mem.sightings).toEqual([]);
  });

  it("doesn't do that bookkeeping for a rookie", () => {
    expect(liar('rookie')).not.toContain('CONFLICT');
  });

  it("gives a mastermind saboteur its kills and a safe story", () => {
    const g = scene();
    place(g, 'p0', { x: 32.5, y: 20.5 });
    place(g, 'p2', { x: 33.5, y: 20.5 });
    const mem = new Memory('p0', TIERS.mastermind, new Rng(1));
    mem.observe(g.observe('p0'));
    g.act('p0', { type: 'kill', targetId: 'p2' });
    mem.noteKill('p2', 'commons', g.tick);
    stepSec(g, 1);
    const obs = g.observe('p0');
    mem.observe(obs);
    const notes = buildNotes({ obs, memory: mem, tier: TIERS.mastermind, nav: g.nav, config: g.config, name: (id) => g.player(id).name });
    expect(notes).toContain('You killed P2 in Commons');
    expect(notes).toContain('Crew who were close enough to see you this round:');
    expect(notes).toMatch(/Safe story: say you were in .+ doing ".+"/);
  });
});

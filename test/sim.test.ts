import { describe, expect, it } from 'vitest';
import { NavGrid, STATION_MAP } from '../src/engine';
import { runScriptedGame } from '../src/sim/runGame';
import { checkInvariants } from '../src/sim/validate';

describe('headless simulation', () => {
  it('runs 100 scripted games that all finish with consistent results', () => {
    const nav = new NavGrid(STATION_MAP);
    const winners = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      const s = runScriptedGame({ seed, nav });
      expect(checkInvariants(s.game), `seed ${seed}`).toEqual([]);
      expect(s.result.reason, `seed ${seed} timed out`).not.toBe('timeout');
      winners.add(s.result.winner);
    }
    expect([...winners].sort()).toEqual(['crew', 'saboteurs']);
  }, 120_000);

  it('replays the exact same game from the same seed', () => {
    const a = runScriptedGame({ seed: 42 });
    const b = runScriptedGame({ seed: 42 });
    expect(JSON.stringify(b.game.events)).toBe(JSON.stringify(a.game.events));
  });

  it('plays a different game from a different seed', () => {
    const a = runScriptedGame({ seed: 1 });
    const b = runScriptedGame({ seed: 2 });
    expect(JSON.stringify(b.game.events)).not.toBe(JSON.stringify(a.game.events));
  });

  it('has a validator that actually catches broken games', () => {
    const s = runScriptedGame({ seed: 5 });
    const dead = s.game.players.find((p) => !p.alive)!;
    dead.alive = true;
    expect(checkInvariants(s.game).length).toBeGreaterThan(0);
  });
});

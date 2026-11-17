import { Game, STATION_MAP, TICK_RATE, type GameConfig, type MapDef, type PlayerId, type PlayerSetup, type Vec2 } from '../src/engine';

/** Short timers so rule tests don't have to simulate minutes of waiting. */
export const FAST: Partial<GameConfig> = {
  discussionSec: 0,
  votingSec: 10,
  resultSec: 1,
  initialKillCooldownSec: 0,
  emergencyCooldownSec: 0,
};

/** Players p0..p(n-1); the listed ids are saboteurs, everyone else crew. */
export function makeGame(opts: { players?: number; saboteurs?: PlayerId[]; config?: Partial<GameConfig>; seed?: number; map?: MapDef } = {}): Game {
  const n = opts.players ?? 5;
  const sabs = new Set(opts.saboteurs ?? ['p0']);
  const players: PlayerSetup[] = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    color: 'grey',
    role: sabs.has(`p${i}`) ? 'saboteur' : 'crew',
  }));
  return new Game({
    map: opts.map ?? STATION_MAP,
    players,
    seed: opts.seed ?? 1,
    config: { saboteurs: sabs.size, ...FAST, ...opts.config },
  });
}

export function place(game: Game, id: PlayerId, pos: Vec2): void {
  game.player(id).pos = { ...pos };
}

export function stepTicks(game: Game, ticks: number): void {
  for (let i = 0; i < ticks; i++) game.step();
}

export function stepSec(game: Game, sec: number): void {
  stepTicks(game, Math.round(sec * TICK_RATE));
}

/** Start an emergency meeting as `caller` and move it straight to voting. */
export function openVoting(game: Game, caller: PlayerId = 'p1'): void {
  place(game, caller, game.map.button.pos);
  const r = game.act(caller, { type: 'call_meeting' });
  if (!r.ok) throw new Error(r.reason);
  while (game.state.meeting?.stage === 'discussion') game.step();
}

/**
 * Two rooms side by side with a one-tile wall between them and a door at the bottom.
 *
 *   A A A A # B B B B
 *   A A A A # B B B B
 *   ...
 *   A A A A D B B B B   (D = door)
 */
export const TWO_ROOMS: MapDef = {
  id: 'two-rooms',
  name: 'Two rooms',
  width: 11,
  height: 7,
  areas: [
    { id: 'a', name: 'Room A', kind: 'room', rect: { x: 1, y: 1, w: 4, h: 5 } },
    { id: 'b', name: 'Room B', kind: 'room', rect: { x: 6, y: 1, w: 4, h: 5 } },
    { id: 'door', name: 'Door', kind: 'hall', rect: { x: 5, y: 5, w: 1, h: 1 } },
  ],
  stations: [
    { id: 's1', name: 'Short job', areaId: 'a', pos: { x: 2.5, y: 2.5 }, kind: 'short' },
    { id: 'l1', name: 'Long job', areaId: 'b', pos: { x: 8.5, y: 2.5 }, kind: 'long' },
  ],
  button: { areaId: 'a', pos: { x: 3, y: 3 } },
  seats: [
    { x: 1.5, y: 1.5 },
    { x: 2.5, y: 1.5 },
    { x: 3.5, y: 1.5 },
    { x: 1.5, y: 2.5 },
    { x: 2.5, y: 3.5 },
  ],
};

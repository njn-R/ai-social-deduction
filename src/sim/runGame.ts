import {
  deriveSeed,
  Game,
  STATION_MAP,
  ticksToSec,
  type GameConfig,
  type GameEvent,
  type GameResult,
  type MapDef,
  type NavGrid,
  type Role,
} from '../engine';
import type { ControlApi, Controller } from '../bots/controller';
import { ScriptedBot } from '../bots/scriptedBot';
import { DEFAULT_ROSTER } from './roster';

export interface ScriptedGameOptions {
  seed: number;
  players?: number;
  config?: Partial<GameConfig>;
  map?: MapDef;
  /** Prebuilt grid for `map`, shared across many games. */
  nav?: NavGrid;
}

export interface GameSummary {
  seed: number;
  result: GameResult;
  roles: Record<string, Role>;
  durationSec: number;
  meetings: number;
  kills: number;
  ejections: number;
  game: Game;
}

/** Run a game to the end as fast as possible: every controller acts, then the world ticks. */
export function runGame(game: Game, controllers: Controller[]): void {
  const apis: ControlApi[] = controllers.map((c) => ({
    setMove: (dir) => game.setMove(c.id, dir),
    act: (action) => game.act(c.id, action),
  }));
  while (!game.isOver()) {
    for (let i = 0; i < controllers.length && !game.isOver(); i++) {
      controllers[i].update(game.observe(controllers[i].id), apis[i]);
    }
    game.step();
  }
}

/** One headless game with scripted bots in every seat. */
export function runScriptedGame(opts: ScriptedGameOptions): GameSummary {
  const map = opts.map ?? STATION_MAP;
  const count = opts.players ?? 9;
  if (count > DEFAULT_ROSTER.length) throw new Error(`Roster only has ${DEFAULT_ROSTER.length} players`);
  const players = DEFAULT_ROSTER.slice(0, count);
  const game = new Game({ map, players, seed: opts.seed, config: opts.config, nav: opts.nav });
  const bots = players.map((p, i) => new ScriptedBot({ id: p.id, nav: game.nav, config: game.config, seed: deriveSeed(opts.seed, i + 1) }));
  runGame(game, bots);
  return summarize(game);
}

export function summarize(game: Game): GameSummary {
  const events = game.events;
  const start = events.find((e): e is Extract<GameEvent, { type: 'game_started' }> => e.type === 'game_started');
  if (!game.result || !start) throw new Error('Game has not finished');
  return {
    seed: game.seed,
    result: game.result,
    roles: start.roles,
    durationSec: ticksToSec(game.tick),
    meetings: events.filter((e) => e.type === 'meeting_called').length,
    kills: events.filter((e) => e.type === 'kill').length,
    ejections: events.filter((e) => e.type === 'meeting_result' && e.result.ejectedId !== null).length,
    game,
  };
}

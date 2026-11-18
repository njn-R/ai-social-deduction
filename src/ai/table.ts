import { deriveSeed, Rng, type Game, type PlayerId } from '../engine';
import type { ControlApi } from '../bots/controller';
import { AiAgent } from './agent';
import { MeetingDirector, type Pacing } from './director';
import { Journal } from './journal';
import { LlmQueue } from './llm/queue';
import type { LlmProvider } from './llm/types';
import type { Persona } from './personas';
import { systemPrompt } from './prompts';

export interface AiTableOptions {
  game: Game;
  provider: LlmProvider;
  /** One persona per AI seat; their ids must be player ids in `game`. */
  personas: Persona[];
  seed: number;
  concurrency?: number;
  mode: 'virtual' | 'realtime';
  /** Called when an AI starts (true) or stops (false) composing a meeting line ("X is typing"). */
  onTyping?: (playerId: PlayerId, typing: boolean) => void;
  /** Slow meeting talk to reading speed (games with a human). */
  pacing?: Pacing | null;
  /** True while the next AI line should wait (human typing, a line being spoken). */
  hold?: () => boolean;
}

/** Everything that runs the AI seats of a game. Shared by AI-only runs and the live server. */
export interface AiTable {
  queue: LlmQueue;
  journal: Journal;
  agents: AiAgent[];
  director: MeetingDirector;
  /** Let every AI act on its latest observation, then run the meeting conversation. */
  update(): void;
}

export function buildAiTable(o: AiTableOptions): AiTable {
  const { game } = o;
  const queue = new LlmQueue(o.provider, { concurrency: o.concurrency ?? 4, mode: o.mode });
  const journal = new Journal();
  const names = new Map(game.players.map((p) => [p.id, p.name]));
  const system = systemPrompt(game.nav, game.config, game.players.length);
  const agents = o.personas.map(
    (persona, i) => new AiAgent({ persona, nav: game.nav, config: game.config, queue, journal, system, names, seed: deriveSeed(o.seed, 100 + i) }),
  );
  const director = new MeetingDirector(game, new Map(agents.map((a) => [a.id, a])), new Rng(deriveSeed(o.seed, 999)), {
    onTyping: o.onTyping,
    pacing: o.pacing ?? null,
    hold: o.hold,
  });
  const apis: ControlApi[] = agents.map((a) => ({
    setMove: (dir) => game.setMove(a.id, dir),
    act: (action) => game.act(a.id, action),
  }));
  return {
    queue,
    journal,
    agents,
    director,
    update() {
      for (let i = 0; i < agents.length; i++) agents[i].update(game.observe(agents[i].id), apis[i]);
      director.update();
    },
  };
}

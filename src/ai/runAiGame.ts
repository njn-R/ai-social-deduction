import { deriveSeed, Game, Rng, STATION_MAP, TICK_RATE, type GameConfig, type GameEvent } from '../engine';
import { AiAgent } from './agent';
import { MeetingDirector } from './director';
import { Journal, type JournalEntry } from './journal';
import { LlmQueue, type QueueStats } from './llm/queue';
import type { LlmProvider } from './llm/types';
import { DEFAULT_TABLE, personaById, type Persona } from './personas';
import { systemPrompt } from './prompts';

export interface AiGameOptions {
  seed: number;
  provider: LlmProvider;
  /** Model label for reports (the provider decides what actually runs). */
  model?: string;
  /** Persona ids at the table, in seat order. */
  table?: string[];
  config?: Partial<GameConfig>;
  /** Calls the model may work on at once. */
  concurrency?: number;
  mode?: 'virtual' | 'realtime';
  onEvent?: (e: GameEvent, game: Game) => void;
  onJournal?: (e: JournalEntry) => void;
}

export interface AiGameReport {
  game: Game;
  journal: Journal;
  agents: AiAgent[];
  personas: Persona[];
  stats: QueueStats;
  model: string;
  wallMs: number;
}

/** Play one game with an AI agent in every seat. */
export async function runAiGame(o: AiGameOptions): Promise<AiGameReport> {
  const personas = (o.table ?? DEFAULT_TABLE).map(personaById);
  const players = personas.map((p) => ({ id: p.id, name: p.name, color: p.color }));
  const game = new Game({ map: STATION_MAP, players, seed: o.seed, config: o.config });
  const mode = o.mode ?? 'virtual';
  const queue = new LlmQueue(o.provider, { concurrency: o.concurrency ?? 4, mode });
  const journal = new Journal();
  if (o.onJournal) journal.onEntry(o.onJournal);

  const names = new Map(players.map((p) => [p.id, p.name]));
  const system = systemPrompt(game.nav, game.config, players.length);
  const agents = personas.map(
    (persona, i) => new AiAgent({ persona, nav: game.nav, config: game.config, queue, journal, system, names, seed: deriveSeed(o.seed, 100 + i) }),
  );
  const director = new MeetingDirector(game, new Map(agents.map((a) => [a.id, a])), new Rng(deriveSeed(o.seed, 999)));
  const apis = agents.map((a) => ({
    setMove: (dir: Parameters<Game['setMove']>[1]) => game.setMove(a.id, dir),
    act: (action: Parameters<Game['act']>[1]) => game.act(a.id, action),
  }));

  if (o.onEvent) {
    const onEvent = o.onEvent;
    for (const e of game.events) onEvent(e, game);
    game.onEvent((e) => onEvent(e, game));
  }

  const started = performance.now();
  while (!game.isOver()) {
    await queue.sync(game.tick);
    for (let i = 0; i < agents.length; i++) agents[i].update(game.observe(agents[i].id), apis[i]);
    director.update();
    game.step();
    if (mode === 'realtime') {
      const wait = started + (game.tick * 1000) / TICK_RATE - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  await queue.drain();
  return { game, journal, agents, personas, stats: queue.stats, model: o.model ?? o.provider.name, wallMs: performance.now() - started };
}

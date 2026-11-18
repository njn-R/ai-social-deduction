import { Game, STATION_MAP, TICK_RATE, type GameConfig, type GameEvent } from '../engine';
import type { AiAgent } from './agent';
import type { Journal, JournalEntry } from './journal';
import type { QueueStats } from './llm/queue';
import type { LlmProvider } from './llm/types';
import { DEFAULT_TABLE, personaById, type Persona } from './personas';
import { buildAiTable } from './table';

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
  const table = buildAiTable({ game, provider: o.provider, personas, seed: o.seed, concurrency: o.concurrency, mode });
  if (o.onJournal) table.journal.onEntry(o.onJournal);

  if (o.onEvent) {
    const onEvent = o.onEvent;
    for (const e of game.events) onEvent(e, game);
    game.onEvent((e) => onEvent(e, game));
  }

  const started = performance.now();
  while (!game.isOver()) {
    await table.queue.sync(game.tick);
    table.update();
    game.step();
    if (mode === 'realtime') {
      const wait = started + (game.tick * 1000) / TICK_RATE - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  await table.queue.drain();
  return {
    game,
    journal: table.journal,
    agents: table.agents,
    personas,
    stats: table.queue.stats,
    model: o.model ?? o.provider.name,
    wallMs: performance.now() - started,
  };
}

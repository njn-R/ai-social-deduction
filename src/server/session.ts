import { computeMetrics } from '../ai/metrics';
import { saveRun } from '../ai/output';
import { CAST, DEFAULT_TABLE, personaById, type Persona } from '../ai/personas';
import { buildReveal } from '../ai/reveal';
import type { AiGameReport } from '../ai/runAiGame';
import { buildAiTable, type AiTable } from '../ai/table';
import type { LlmProvider } from '../ai/llm/types';
import { HUMAN_PACING, VOICE_PACING } from '../ai/director';
import { clampLength, Game, Rng, secToTicks, STATION_MAP, TICK_RATE, type GameConfig, type PlayerSetup, type Vec2 } from '../engine';
import type { ClientMessage, RoleChoice, ServerMessage } from '../shared/protocol';
import { parseHumanChat } from './humanChat';

export const HUMAN_ID = 'you';

/** Seconds the game waits at the start so you can read your role. */
export const INTRO_SEC = 7;

export interface SessionOptions {
  provider: LlmProvider;
  /** Label for reports. */
  model: string;
  humanName: string;
  role: RoleChoice;
  seed: number;
  concurrency?: number;
  /** 'realtime' for play; 'virtual' lets tests run a session as fast as possible. */
  mode?: 'realtime' | 'virtual';
  send: (msg: ServerMessage) => void;
  /** Where to save the reveal; null to skip saving. */
  outDir?: string | null;
  /** Rule overrides (e.g. a short time limit for testing). */
  config?: Partial<GameConfig>;
}

/** A display name that's safe to show and can't be mistaken for an AI. */
export function cleanName(raw: string): string {
  const name = raw.replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Player';
  return CAST.some((c) => c.name.toLowerCase() === name.toLowerCase()) ? `${name} 2` : name;
}

/**
 * One live game: the human in seat 1, AIs in the rest. Runs on the wall clock and only ever
 * sends the human their own observation.
 */
export class GameSession {
  readonly game: Game;
  readonly table: AiTable;
  readonly personas: Persona[];
  private move: Vec2 | null = null;
  private running = false;
  private finished = false;
  private lastChatTick = -Infinity;
  private lastTypingTick = -Infinity;
  /** Ends the role-reveal pause early (set while it's running). */
  private endIntro: (() => void) | null = null;
  /** The browser is behind on reading AI lines aloud. */
  private speaking = false;
  /** AI lines are being read aloud, so listening (not reading) sets the pace. */
  private voices = false;
  private startedAt = 0;

  constructor(private readonly o: SessionOptions) {
    const rng = new Rng(o.seed);
    const seats = [...DEFAULT_TABLE];
    seats.splice(rng.int(seats.length), 1); // the human takes one of the 9 seats
    this.personas = seats.map(personaById);
    const human: PlayerSetup = {
      id: HUMAN_ID,
      name: cleanName(o.humanName),
      color: 'cyan',
      ...(o.role === 'random' ? {} : { role: o.role }),
    };
    const players = [human, ...this.personas.map((p) => ({ id: p.id, name: p.name, color: p.color }))];
    // A human needs longer than 90 s to read, think and type.
    this.game = new Game({ map: STATION_MAP, players, seed: o.seed, config: { discussionSec: 120, ...o.config } });
    this.table = buildAiTable({
      game: this.game,
      provider: o.provider,
      personas: this.personas,
      seed: o.seed,
      concurrency: o.concurrency,
      mode: o.mode ?? 'realtime',
      onTyping: (id, on) => o.send({ type: 'typing', playerId: id, on }),
      pacing: () => (this.voices ? VOICE_PACING : HUMAN_PACING),
      hold: () => this.game.tick - this.lastTypingTick < secToTicks(2.5) || this.speaking,
    });
  }

  welcome(): ServerMessage {
    const voices = Object.fromEntries(this.personas.map((p) => [p.id, p.speech]));
    return { type: 'welcome', you: HUMAN_ID, map: this.game.map, config: this.game.config, voices };
  }

  get over(): boolean {
    return this.finished;
  }

  /** Advance one tick and send the human what they can now see. */
  async step(): Promise<void> {
    const g = this.game;
    if (g.isOver()) return;
    await this.table.queue.sync(g.tick);
    this.table.update();
    if (g.phase === 'playing') g.setMove(HUMAN_ID, this.move);
    g.step();
    this.o.send({ type: 'obs', obs: g.observe(HUMAN_ID) });
    if (g.isOver()) await this.finish();
  }

  /**
   * Show the human their starting view and role, wait `introSec` (or until they say they're
   * ready), then start the 20-ticks-a-second loop. Nothing moves during the intro.
   */
  run(introSec = INTRO_SEC): void {
    this.running = true;
    this.o.send({ type: 'obs', obs: this.game.observe(HUMAN_ID) });
    this.o.send({ type: 'intro', seconds: introSec });
    const intro = new Promise<void>((resolve) => {
      this.endIntro = resolve;
      setTimeout(resolve, introSec * 1000);
    });
    const loop = async () => {
      await intro;
      this.endIntro = null;
      this.startedAt = performance.now();
      while (this.running && !this.game.isOver()) {
        await this.step();
        const wait = this.startedAt + (this.game.tick * 1000) / TICK_RATE - performance.now();
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));
      }
    };
    loop().catch((e: unknown) => this.o.send({ type: 'error', message: String(e) }));
  }

  stop(): void {
    this.running = false;
    void this.table.queue.drain();
  }

  handle(msg: ClientMessage): void {
    const g = this.game;
    switch (msg.type) {
      case 'move':
        this.move = msg.dir && Number.isFinite(msg.dir.x) && Number.isFinite(msg.dir.y) ? clampLength(msg.dir, 1) : null;
        return;
      case 'act': {
        const r = g.act(HUMAN_ID, msg.action);
        if (!r.ok) this.o.send({ type: 'notice', text: r.reason });
        return;
      }
      case 'ready':
        this.endIntro?.();
        return;
      case 'typing':
        this.lastTypingTick = g.tick;
        return;
      case 'speaking':
        this.speaking = msg.on === true;
        return;
      case 'voice':
        this.voices = msg.on === true;
        if (!this.voices) this.speaking = false;
        return;
      case 'chat': {
        this.lastTypingTick = -Infinity;
        const text = String(msg.text ?? '').trim().slice(0, 240);
        if (!text) return;
        if (g.tick - this.lastChatTick < TICK_RATE * 1.5) {
          this.o.send({ type: 'notice', text: 'Slow down a little.' });
          return;
        }
        const r = g.act(HUMAN_ID, { type: 'chat', text, ...parseHumanChat(text, g, HUMAN_ID) });
        if (r.ok) this.lastChatTick = g.tick;
        else this.o.send({ type: 'notice', text: r.reason });
        return;
      }
      case 'start':
        return; // handled by the server, which replaces the session
    }
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    await this.table.queue.drain();
    const g = this.game;
    const report: AiGameReport = {
      game: g,
      journal: this.table.journal,
      agents: this.table.agents,
      personas: this.personas,
      stats: this.table.queue.stats,
      model: this.o.model,
      wallMs: performance.now() - this.startedAt,
    };
    const metrics = computeMetrics(report, this.o.seed);
    if (this.o.outDir !== null) saveRun(this.o.outDir ?? 'runs', report, metrics);
    this.o.send({
      type: 'game_over',
      result: g.result!,
      roles: Object.fromEntries(g.players.map((p) => [p.id, p.role])),
      reveal: buildReveal(report, metrics),
    });
  }
}

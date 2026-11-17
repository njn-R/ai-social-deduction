import { DEFAULT_CONFIG, secToTicks, TICK_RATE, type GameConfig } from './config';
import { clampLength, dist, scale, type Vec2 } from './geometry';
import { NavGrid } from './map/navGrid';
import type { MapDef } from './map/types';
import { buildObservation, type Observation } from './observation';
import { Rng } from './rng';
import type {
  Action,
  ActionResult,
  BodyState,
  ChatMessage,
  GameEvent,
  GameEventBody,
  GameResult,
  GameState,
  MeetingReason,
  MeetingState,
  PlayerId,
  PlayerSetup,
  PlayerState,
  PlayerTask,
  Role,
  VoteTarget,
  Winner,
  WinReason,
} from './types';

export interface GameOptions {
  map: MapDef;
  players: PlayerSetup[];
  seed: number;
  config?: Partial<GameConfig>;
  /** Reuse a prebuilt grid for the same map (saves work when running many games). */
  nav?: NavGrid;
}

const OK: ActionResult = { ok: true };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

/**
 * The authoritative game. Holds the real state and enforces every rule.
 *
 * Controllers (bots, AI agents, the human client) drive it with:
 * - `setMove(id, dir)`  – movement intent, applied each tick
 * - `act(id, action)`   – discrete actions, validated and applied immediately
 * - `observe(id)`       – the only view of the world a controller should use
 * and the host calls `step()` once per tick.
 */
export class Game {
  readonly config: GameConfig;
  readonly map: MapDef;
  readonly nav: NavGrid;
  readonly seed: number;
  readonly state: GameState;
  readonly events: GameEvent[] = [];
  private readonly rng: Rng;
  private readonly byId = new Map<PlayerId, PlayerState>();
  private readonly listeners = new Set<(e: GameEvent) => void>();

  constructor(opts: GameOptions) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.map = opts.map;
    this.nav = opts.nav ?? new NavGrid(opts.map);
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed);

    const setups = opts.players;
    this.validateSetup(setups);
    const roles = this.dealRoles(setups);
    const players: PlayerState[] = setups.map((s, i) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      role: roles[i],
      alive: true,
      ejected: false,
      diedAtTick: null,
      pos: { ...this.map.seats[i] },
      move: null,
      killCooldownTicks: roles[i] === 'saboteur' ? secToTicks(this.config.initialKillCooldownSec) : 0,
      tasks: this.dealTasks(),
      busy: null,
      emergencyLeft: this.config.emergencyMeetingsPerPlayer,
    }));
    for (const p of players) this.byId.set(p.id, p);

    this.state = {
      tick: 0,
      phase: 'playing',
      round: 1,
      players,
      bodies: [],
      meeting: null,
      meetingsHeld: 0,
      buttonReadyTick: secToTicks(this.config.emergencyCooldownSec),
      publicDead: [],
      result: null,
      nextBodyId: 1,
    };
    this.emit({ type: 'game_started', roles: Object.fromEntries(players.map((p) => [p.id, p.role])) });
  }

  // ── Read access ────────────────────────────────────────────────────────

  get tick(): number {
    return this.state.tick;
  }

  get phase(): GameState['phase'] {
    return this.state.phase;
  }

  get result(): GameResult | null {
    return this.state.result;
  }

  get players(): readonly PlayerState[] {
    return this.state.players;
  }

  player(id: PlayerId): PlayerState {
    const p = this.byId.get(id);
    if (!p) throw new Error(`Unknown player ${id}`);
    return p;
  }

  onEvent(fn: (e: GameEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What one player can know right now. Controllers should decide only from this. */
  observe(id: PlayerId): Observation {
    return buildObservation(this, this.player(id));
  }

  visionRadius(p: PlayerState): number {
    return p.role === 'saboteur' ? this.config.saboteurVision : this.config.crewVision;
  }

  canSee(viewer: PlayerState, pos: Vec2): boolean {
    if (dist(viewer.pos, pos) > this.visionRadius(viewer)) return false;
    return this.nav.hasLineOfSight(viewer.pos, pos);
  }

  /** Crew task progress. Saboteurs' fake tasks don't count. */
  taskProgress(): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const p of this.state.players) {
      if (p.role !== 'crew') continue;
      for (const t of p.tasks) {
        total++;
        if (t.done) done++;
      }
    }
    return { done, total };
  }

  aliveCounts(): { crew: number; saboteurs: number } {
    let crew = 0;
    let saboteurs = 0;
    for (const p of this.state.players) {
      if (!p.alive) continue;
      if (p.role === 'saboteur') saboteurs++;
      else crew++;
    }
    return { crew, saboteurs };
  }

  // ── Input ──────────────────────────────────────────────────────────────

  /** Set movement intent (length ≤ 1, scaled by player speed). Moving cancels a task in progress. */
  setMove(id: PlayerId, dir: Vec2 | null): void {
    const p = this.player(id);
    if (this.state.phase !== 'playing' || !dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y) || (dir.x === 0 && dir.y === 0)) {
      p.move = null;
      return;
    }
    p.move = clampLength(dir, 1);
    this.cancelTask(p);
  }

  act(id: PlayerId, action: Action): ActionResult {
    const p = this.player(id);
    if (this.isOver()) return fail('the game is over');
    switch (action.type) {
      case 'start_task':
        return this.startTask(p, action.stationId);
      case 'kill':
        return this.kill(p, action.targetId);
      case 'report':
        return this.report(p, action.bodyId);
      case 'call_meeting':
        return this.callMeeting(p);
      case 'chat':
        return this.chat(p, action.text, action.accuse);
      case 'vote':
        return this.vote(p, action.target);
    }
  }

  /** Advance one tick (1 / TICK_RATE seconds of game time). */
  step(): void {
    const s = this.state;
    if (this.isOver()) return;
    s.tick++;

    if (s.phase === 'playing') {
      for (const p of s.players) if (p.move && !p.busy) this.movePlayer(p, p.move);
      for (const p of s.players) if (p.role === 'saboteur' && p.killCooldownTicks > 0) p.killCooldownTicks--;
      for (const p of s.players) {
        if (p.busy && s.tick >= p.busy.untilTick) {
          this.completeTask(p);
          if (this.isOver()) return;
        }
      }
    } else if (s.phase === 'meeting' && s.meeting && s.tick >= s.meeting.stageEndsTick) {
      this.advanceMeeting(s.meeting);
    }

    if (!this.isOver() && s.tick >= secToTicks(this.config.maxGameSec)) this.endGame('none', 'timeout');
  }

  // ── Setup ──────────────────────────────────────────────────────────────

  private validateSetup(setups: PlayerSetup[]): void {
    if (setups.length < 3) throw new Error('Need at least 3 players');
    if (setups.length > this.map.seats.length) {
      throw new Error(`Map ${this.map.id} has ${this.map.seats.length} seats but ${setups.length} players were given`);
    }
    if (new Set(setups.map((s) => s.id)).size !== setups.length) throw new Error('Player ids must be unique');
    const sab = this.config.saboteurs;
    if (sab < 1 || sab * 2 >= setups.length) {
      throw new Error(`${sab} saboteurs doesn't work with ${setups.length} players (saboteurs must start outnumbered)`);
    }
  }

  private dealRoles(setups: PlayerSetup[]): Role[] {
    const forced = setups.filter((s) => s.role === 'saboteur').length;
    const needed = this.config.saboteurs - forced;
    if (needed < 0) throw new Error('More players forced to saboteur than config.saboteurs allows');
    const open = setups.flatMap((s, i) => (s.role ? [] : [i]));
    if (open.length < needed) throw new Error('Not enough players without a forced role to deal saboteurs');
    const picked = new Set(this.rng.shuffle(open).slice(0, needed));
    return setups.map((s, i) => s.role ?? (picked.has(i) ? 'saboteur' : 'crew'));
  }

  private dealTasks(): PlayerTask[] {
    const longs = this.map.stations.filter((s) => s.kind === 'long');
    const shorts = this.map.stations.filter((s) => s.kind === 'short');
    const { longTasks, shortTasks } = this.config;
    if (longs.length < longTasks || shorts.length < shortTasks) {
      throw new Error(`Map ${this.map.id} doesn't have enough task stations for ${longTasks} long + ${shortTasks} short tasks`);
    }
    const chosen = [...this.rng.shuffle(longs).slice(0, longTasks), ...this.rng.shuffle(shorts).slice(0, shortTasks)];
    return chosen.map((s) => ({ stationId: s.id, done: false }));
  }

  // ── Movement & tasks ───────────────────────────────────────────────────

  private movePlayer(p: PlayerState, dir: Vec2): void {
    const d = scale(dir, this.config.playerSpeed / TICK_RATE);
    const full = { x: p.pos.x + d.x, y: p.pos.y + d.y };
    if (this.nav.isWalkable(full)) {
      p.pos = full;
      return;
    }
    // Slide along walls.
    const alongX = { x: p.pos.x + d.x, y: p.pos.y };
    if (d.x !== 0 && this.nav.isWalkable(alongX)) {
      p.pos = alongX;
      return;
    }
    const alongY = { x: p.pos.x, y: p.pos.y + d.y };
    if (d.y !== 0 && this.nav.isWalkable(alongY)) p.pos = alongY;
  }

  private startTask(p: PlayerState, stationId: string): ActionResult {
    if (this.state.phase !== 'playing') return fail('tasks can only be done during play');
    if (!p.alive && !(p.role === 'crew' && this.config.ghostsDoTasks)) return fail('dead players cannot do tasks');
    if (p.busy) return fail('already busy with a task');
    const task = p.tasks.find((t) => t.stationId === stationId);
    if (!task) return fail('not one of your tasks');
    if (task.done) return fail('task already done');
    const station = this.nav.station(stationId);
    if (dist(p.pos, station.pos) > this.config.taskRange) return fail('too far from the task');

    const sec = station.kind === 'long' ? this.config.longTaskSec : this.config.shortTaskSec;
    p.busy = { stationId, untilTick: this.state.tick + secToTicks(sec) };
    p.move = null;
    this.emit({ type: 'task_started', playerId: p.id, stationId });
    return OK;
  }

  private completeTask(p: PlayerState): void {
    if (!p.busy) return;
    const { stationId } = p.busy;
    p.busy = null;
    const task = p.tasks.find((t) => t.stationId === stationId);
    if (task) task.done = true;
    this.emit({ type: 'task_completed', playerId: p.id, stationId, fake: p.role === 'saboteur' });
    if (p.role === 'crew') {
      const { done, total } = this.taskProgress();
      if (done >= total) this.endGame('crew', 'tasks');
    }
  }

  private cancelTask(p: PlayerState): void {
    if (!p.busy) return;
    const { stationId } = p.busy;
    p.busy = null;
    this.emit({ type: 'task_cancelled', playerId: p.id, stationId });
  }

  // ── Kills, reports, meetings ───────────────────────────────────────────

  private kill(killer: PlayerState, targetId: PlayerId): ActionResult {
    const s = this.state;
    if (s.phase !== 'playing') return fail('can only kill during play');
    if (!killer.alive) return fail('dead players cannot kill');
    if (killer.role !== 'saboteur') return fail('only saboteurs can kill');
    if (killer.killCooldownTicks > 0) return fail('kill is on cooldown');
    const target = this.byId.get(targetId);
    if (!target || target.id === killer.id) return fail('invalid target');
    if (!target.alive) return fail('target is already dead');
    if (target.role === 'saboteur') return fail('cannot kill a fellow saboteur');
    if (dist(killer.pos, target.pos) > this.config.killRange) return fail('target is out of range');
    if (!this.nav.hasLineOfSight(killer.pos, target.pos)) return fail('no clear line to the target');

    this.cancelTask(killer);
    this.cancelTask(target);
    target.alive = false;
    target.diedAtTick = s.tick;
    target.move = null;
    const body: BodyState = {
      id: `body-${s.nextBodyId++}`,
      victimId: target.id,
      pos: { ...target.pos },
      areaId: this.nav.areaAt(target.pos)?.id ?? null,
      tick: s.tick,
    };
    s.bodies.push(body);
    killer.pos = { ...target.pos }; // the killer lunges onto the victim
    killer.killCooldownTicks = secToTicks(this.config.killCooldownSec);
    this.emit({ type: 'kill', killerId: killer.id, victimId: target.id, bodyId: body.id, pos: { ...body.pos }, areaId: body.areaId });

    const { crew, saboteurs } = this.aliveCounts();
    if (saboteurs >= crew) this.endGame('saboteurs', 'parity');
    return OK;
  }

  private report(p: PlayerState, bodyId: string): ActionResult {
    const s = this.state;
    if (s.phase !== 'playing') return fail('can only report during play');
    if (!p.alive) return fail('dead players cannot report');
    const body = s.bodies.find((b) => b.id === bodyId);
    if (!body) return fail('no such body');
    if (dist(p.pos, body.pos) > this.config.reportRange) return fail('too far from the body');
    if (!this.nav.hasLineOfSight(p.pos, body.pos)) return fail('cannot see the body from here');
    this.startMeeting('body', p, body);
    return OK;
  }

  private callMeeting(p: PlayerState): ActionResult {
    const s = this.state;
    if (s.phase !== 'playing') return fail('can only call a meeting during play');
    if (!p.alive) return fail('dead players cannot call meetings');
    if (p.emergencyLeft <= 0) return fail('no emergency meetings left');
    if (s.tick < s.buttonReadyTick) return fail('the button is not ready yet');
    if (dist(p.pos, this.map.button.pos) > this.config.buttonRange) return fail('too far from the button');
    p.emergencyLeft--;
    this.startMeeting('emergency', p, null);
    return OK;
  }

  private startMeeting(reason: MeetingReason, caller: PlayerState, body: BodyState | null): void {
    const s = this.state;
    for (const p of s.players) {
      p.move = null;
      this.cancelTask(p);
    }
    s.publicDead = s.players.filter((p) => !p.alive).map((p) => p.id);
    s.phase = 'meeting';
    s.meeting = {
      index: s.meetingsHeld++,
      reason,
      calledBy: caller.id,
      victimId: body?.victimId ?? null,
      bodyAreaId: body?.areaId ?? null,
      participants: s.players.filter((p) => p.alive).map((p) => p.id),
      stage: 'discussion',
      startTick: s.tick,
      stageEndsTick: s.tick + secToTicks(this.config.discussionSec),
      votes: {},
      chat: [],
      result: null,
    };
    s.bodies = [];
    this.emit({ type: 'meeting_called', reason, callerId: caller.id, victimId: s.meeting.victimId, bodyAreaId: s.meeting.bodyAreaId });
  }

  private chat(p: PlayerState, text: string, accuse?: PlayerId): ActionResult {
    const s = this.state;
    const m = s.meeting;
    if (s.phase !== 'meeting' || !m) return fail('chat is only open during meetings');
    if (m.stage === 'result') return fail('the meeting is wrapping up');
    if (!p.alive || !m.participants.includes(p.id)) return fail('only living players can talk');
    const clean = text.trim();
    if (!clean) return fail('empty message');
    if (clean.length > 300) return fail('message too long (max 300 characters)');
    if (accuse !== undefined && !this.byId.has(accuse)) return fail('unknown accused player');

    const msg: ChatMessage = { tick: s.tick, playerId: p.id, text: clean, ...(accuse ? { accuse } : {}) };
    m.chat.push(msg);
    this.emit({ type: 'chat', playerId: p.id, text: clean, ...(accuse ? { accuse } : {}) });
    return OK;
  }

  private vote(p: PlayerState, target: VoteTarget): ActionResult {
    const s = this.state;
    const m = s.meeting;
    if (s.phase !== 'meeting' || !m) return fail('no meeting in progress');
    if (m.stage !== 'voting') return fail('voting is not open');
    if (!p.alive || !m.participants.includes(p.id)) return fail('only living players can vote');
    if (m.votes[p.id] !== undefined) return fail('already voted');
    if (target !== 'skip') {
      const t = this.byId.get(target);
      if (!t || !t.alive) return fail('can only vote for a living player');
    }
    m.votes[p.id] = target;
    this.emit({ type: 'vote_cast', voterId: p.id, target });
    if (m.participants.every((id) => m.votes[id] !== undefined)) this.resolveVotes(m);
    return OK;
  }

  private advanceMeeting(m: MeetingState): void {
    if (m.stage === 'discussion') {
      m.stage = 'voting';
      m.stageEndsTick = this.state.tick + secToTicks(this.config.votingSec);
      this.emit({ type: 'voting_started' });
    } else if (m.stage === 'voting') {
      this.resolveVotes(m);
    } else {
      this.finishMeeting();
    }
  }

  /** Plurality wins. A tie, or skip coming out on top, ejects nobody. */
  private resolveVotes(m: MeetingState): void {
    const s = this.state;
    const tally: Record<string, number> = {};
    for (const id of m.participants) {
      const v = m.votes[id];
      if (v !== undefined) tally[v] = (tally[v] ?? 0) + 1;
    }
    let top: string | null = null;
    let topCount = 0;
    let tie = false;
    for (const [target, count] of Object.entries(tally)) {
      if (count > topCount) {
        top = target;
        topCount = count;
        tie = false;
      } else if (count === topCount) {
        tie = true;
      }
    }
    const ejectedId = !tie && top !== null && top !== 'skip' ? top : null;
    let revealedRole: Role | null = null;
    if (ejectedId) {
      const p = this.player(ejectedId);
      p.alive = false;
      p.ejected = true;
      p.diedAtTick = s.tick;
      s.publicDead.push(p.id);
      if (this.config.confirmEjects) revealedRole = p.role;
    }
    m.result = { ejectedId, tie, tally, votes: { ...m.votes }, revealedRole };
    m.stage = 'result';
    m.stageEndsTick = s.tick + secToTicks(this.config.resultSec);
    this.emit({ type: 'meeting_result', result: { ...m.result, tally: { ...tally }, votes: { ...m.votes } } });
  }

  private finishMeeting(): void {
    const s = this.state;
    s.meeting = null;
    const { crew, saboteurs } = this.aliveCounts();
    if (saboteurs === 0) return this.endGame('crew', 'saboteurs_ejected');
    if (saboteurs >= crew) return this.endGame('saboteurs', 'parity');

    s.phase = 'playing';
    s.round++;
    s.players.forEach((p, i) => {
      p.pos = { ...this.map.seats[i] };
      p.move = null;
      if (p.role === 'saboteur') p.killCooldownTicks = secToTicks(this.config.killCooldownSec);
    });
    s.buttonReadyTick = s.tick + secToTicks(this.config.emergencyCooldownSec);
    this.emit({ type: 'round_started', round: s.round });
  }

  private endGame(winner: Winner, reason: WinReason): void {
    const s = this.state;
    if (this.isOver()) return;
    s.phase = 'ended';
    s.meeting = null;
    for (const p of s.players) p.move = null;
    s.result = { winner, reason, tick: s.tick };
    this.emit({ type: 'game_over', result: { ...s.result } });
  }

  isOver(): boolean {
    return this.state.phase === 'ended';
  }

  private emit(body: GameEventBody): void {
    const e = { ...body, tick: this.state.tick } as GameEvent;
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
  }
}

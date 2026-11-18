import {
  dist,
  NavGrid,
  Rng,
  secToTicks,
  TICK_RATE,
  type GameConfig,
  type Observation,
  type PlayerId,
  type Vec2,
  type VisibleBody,
  type VisiblePlayer,
} from '../engine';
import type { ControlApi } from './controller';
import { Navigator } from './navigator';

export type Aggression = 'patient' | 'normal' | 'aggressive';

/** The knobs an LLM round plan (or a persona) can turn. Everything else is reflex. */
export interface PlayPolicy {
  /** Prefer tasks where this player is, and follow them when idle. */
  buddy: PlayerId | null;
  /** Steer clear of this player. */
  avoid: PlayerId | null;
  /** Saboteur: preferred victim. */
  target: PlayerId | null;
  aggression: Aggression;
  /** Saboteur: chance to "find" and report their own kill instead of running. */
  selfReportChance: number;
}

export const DEFAULT_POLICY: PlayPolicy = { buddy: null, avoid: null, target: null, aggression: 'normal', selfReportChance: 0 };

/**
 * Moment-to-moment play shared by scripted bots and AI agents: walking, doing (or faking)
 * tasks, reporting bodies, and the saboteur's kill-and-run. Runs every tick, costs nothing.
 */
export class Reflexes {
  policy: PlayPolicy = { ...DEFAULT_POLICY };
  private readonly walker: Navigator;
  private round = 0;
  private taskTarget: string | null = null;
  private wanderTarget: Vec2 | null = null;
  private fleeTarget: Vec2 | null = null;
  private lastCrowdTick = -Infinity;
  private selfReport: { bodyAtTick: number; atTick: number } | null = null;

  constructor(
    private readonly nav: NavGrid,
    private readonly config: GameConfig,
    private readonly rng: Rng,
  ) {
    this.walker = new Navigator(nav, config.playerSpeed / TICK_RATE);
  }

  /** Forget the current path (call when a meeting starts). */
  pause(): void {
    this.walker.clear();
  }

  play(obs: Observation, api: ControlApi): void {
    if (obs.round !== this.round) this.startRound(obs.round);
    if (obs.self.role === 'saboteur') this.playSaboteur(obs, api);
    else this.playCrew(obs, api);
  }

  private startRound(round: number): void {
    this.round = round;
    this.taskTarget = null;
    this.wanderTarget = null;
    this.fleeTarget = null;
    this.selfReport = null;
    this.lastCrowdTick = -Infinity;
    this.walker.clear();
  }

  // ── Crew ───────────────────────────────────────────────────────────────

  private playCrew(obs: Observation, api: ControlApi): void {
    const me = obs.self;
    if (me.alive) {
      const body = nearestBody(obs);
      if (body) {
        if (dist(me.pos, body.pos) <= this.config.reportRange - 0.3 && api.act({ type: 'report', bodyId: body.id }).ok) return;
        this.goTo(body.pos, obs, api);
        return;
      }
    }
    if (me.busy) {
      api.setMove(null);
      return;
    }
    if (!me.alive && !this.config.ghostsDoTasks) {
      api.setMove(null);
      return;
    }
    this.dodge(obs);
    if (this.doTasks(obs, api)) return;
    if (!me.alive) {
      api.setMove(null);
      return;
    }
    if (this.followBuddy(obs, api)) return;
    this.wander(obs, api);
  }

  // ── Saboteur ───────────────────────────────────────────────────────────

  private playSaboteur(obs: Observation, api: ControlApi): void {
    const me = obs.self;
    if (!me.alive) {
      api.setMove(null);
      return;
    }
    if (this.selfReport) {
      if (this.trySelfReport(obs, api)) return;
    }

    const team = new Set(obs.saboteurTeam);
    const crewInView = obs.visiblePlayers.filter((v) => v.alive && !team.has(v.id));
    if (crewInView.length >= 2) this.lastCrowdTick = obs.tick;
    const ready = (me.killCooldownSec ?? 1) <= 0;

    // Strike only when exactly one crew member is in view. Saboteurs see further
    // than crew, so nobody else can be watching.
    if (ready && crewInView.length === 1 && this.wantsToStrike(obs)) {
      const target = crewInView[0];
      if (dist(me.pos, target.pos) <= this.config.killRange - 0.2 && api.act({ type: 'kill', targetId: target.id }).ok) {
        this.afterKill(obs);
        return;
      }
      this.goTo(target.pos, obs, api, 0.75);
      return;
    }

    if (this.fleeTarget) {
      if (dist(me.pos, this.fleeTarget) > 0.05 && this.goTo(this.fleeTarget, obs, api)) return;
      this.fleeTarget = null;
    }
    // Kill ready and the planned victim is in sight with company: shadow them for an opening.
    const marked = ready ? seen(obs, this.policy.target) : undefined;
    if (marked && !team.has(marked.id)) {
      if (dist(me.pos, marked.pos) > 4) this.goTo(marked.pos, obs, api, 1);
      else api.setMove(null);
      return;
    }
    if (me.busy) {
      api.setMove(null);
      return;
    }
    this.dodge(obs);
    if (this.doTasks(obs, api)) return;
    if (this.followBuddy(obs, api)) return;
    this.wander(obs, api);
  }

  /**
   * Patient saboteurs wait until the area has been quiet for a few seconds. (The planned
   * target only decides who gets hunted first; holding out for one specific victim meant
   * AI saboteurs almost never struck before the crew finished their tasks.)
   */
  private wantsToStrike(obs: Observation): boolean {
    if (this.policy.aggression !== 'patient') return true;
    return obs.tick - this.lastCrowdTick > secToTicks(3);
  }

  private afterKill(obs: Observation): void {
    this.walker.clear();
    if (this.policy.selfReportChance > 0 && this.rng.chance(this.policy.selfReportChance)) {
      this.selfReport = { bodyAtTick: obs.tick, atTick: obs.tick + secToTicks(this.rng.range(1, 3)) };
      return;
    }
    this.startFleeing(obs);
  }

  /** Bold move: stay by the body for a moment, then "discover" it. */
  private trySelfReport(obs: Observation, api: ControlApi): boolean {
    const plan = this.selfReport!;
    const body = nearestBody(obs);
    if (!body || obs.tick - plan.bodyAtTick > secToTicks(6)) {
      this.selfReport = null;
      return false;
    }
    api.setMove(null);
    if (obs.tick >= plan.atTick) {
      this.selfReport = null;
      if (dist(obs.self.pos, body.pos) <= this.config.reportRange) api.act({ type: 'report', bodyId: body.id });
    }
    return true;
  }

  private startFleeing(obs: Observation): void {
    const here = obs.self.pos;
    const rooms = this.nav
      .rooms()
      .filter((r) => r.id !== obs.self.areaId)
      .sort((a, b) => dist(this.nav.areaCenter(b.id), here) - dist(this.nav.areaCenter(a.id), here));
    const room = this.rng.pick(rooms.slice(0, 3));
    this.fleeTarget = this.randomPointIn(room.id);
  }

  // ── Shared ─────────────────────────────────────────────────────────────

  /** If the player to avoid is close and heading for the same room, pick a different task. */
  private dodge(obs: Observation): void {
    const avoid = seen(obs, this.policy.avoid);
    if (!avoid || !this.taskTarget || dist(avoid.pos, obs.self.pos) > 5) return;
    if (this.nav.station(this.taskTarget).areaId !== avoid.areaId) return;
    const todo = obs.self.tasks.filter((t) => !t.done && this.nav.station(t.stationId).areaId !== avoid.areaId);
    if (todo.length > 0) this.taskTarget = this.nearestStation(obs.self.pos, todo.map((t) => t.stationId));
  }

  /** Work through own task list (real for crew, fake for saboteurs). False when there's nothing left. */
  private doTasks(obs: Observation, api: ControlApi): boolean {
    const me = obs.self;
    const todo = me.tasks.filter((t) => !t.done).map((t) => t.stationId);
    if (todo.length === 0) return false;
    if (!this.taskTarget || !todo.includes(this.taskTarget)) this.taskTarget = this.pickTask(obs, todo);
    if (!this.taskTarget) return false;

    const station = this.nav.station(this.taskTarget);
    if (dist(me.pos, station.pos) <= this.config.taskRange - 0.2) {
      api.setMove(null);
      if (!api.act({ type: 'start_task', stationId: this.taskTarget }).ok) this.taskTarget = null;
      return true;
    }
    if (!this.goTo(station.pos, obs, api)) this.taskTarget = null;
    return true;
  }

  private pickTask(obs: Observation, todo: string[]): string | null {
    const buddy = seen(obs, this.policy.buddy);
    if (buddy?.areaId) {
      const near = todo.filter((id) => this.nav.station(id).areaId === buddy.areaId);
      if (near.length > 0) return this.nearestStation(obs.self.pos, near);
    }
    return this.nearestStation(obs.self.pos, todo);
  }

  private followBuddy(obs: Observation, api: ControlApi): boolean {
    const buddy = seen(obs, this.policy.buddy);
    if (!buddy) return false;
    if (dist(obs.self.pos, buddy.pos) <= 2.5) {
      api.setMove(null);
      return true;
    }
    return this.goTo(buddy.pos, obs, api, 1.5);
  }

  private wander(obs: Observation, api: ControlApi): void {
    if (!this.wanderTarget || dist(obs.self.pos, this.wanderTarget) < 0.05) {
      this.wanderTarget = this.randomPointIn(this.rng.pick(this.nav.rooms()).id);
    }
    if (!this.goTo(this.wanderTarget, obs, api)) this.wanderTarget = null;
  }

  private goTo(goal: Vec2, obs: Observation, api: ControlApi, tolerance = 0.01): boolean {
    if (!this.walker.setGoal(goal, obs.self.pos, tolerance)) {
      api.setMove(null);
      return false;
    }
    api.setMove(this.walker.steer(obs.self.pos));
    return true;
  }

  private nearestStation(from: Vec2, stationIds: string[]): string | null {
    let best: string | null = null;
    let bestLen = Infinity;
    for (const id of stationIds) {
      const path = this.nav.findPath(from, this.nav.station(id).pos);
      const len = path ? NavGrid.pathLength(from, path) : Infinity;
      if (len < bestLen) {
        bestLen = len;
        best = id;
      }
    }
    return best;
  }

  private randomPointIn(areaId: string): Vec2 {
    const { x, y, w, h } = this.nav.area(areaId).rect;
    return {
      x: x + 1 + this.rng.int(Math.max(1, w - 2)) + 0.5,
      y: y + 1 + this.rng.int(Math.max(1, h - 2)) + 0.5,
    };
  }
}

/** The given player if they're alive and in view right now. */
function seen(obs: Observation, id: PlayerId | null): VisiblePlayer | undefined {
  return id === null ? undefined : obs.visiblePlayers.find((v) => v.id === id && v.alive);
}

export function nearestBody(obs: Observation): VisibleBody | null {
  let best: VisibleBody | null = null;
  for (const b of obs.visibleBodies) {
    if (!best || dist(obs.self.pos, b.pos) < dist(obs.self.pos, best.pos)) best = b;
  }
  return best;
}

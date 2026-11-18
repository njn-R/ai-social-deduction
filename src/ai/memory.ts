import { dist, Rng, secToTicks, type ChatMessage, type MeetingReason, type MeetingResult, type Observation, type PlayerId } from '../engine';
import type { TierProfile } from './tiers';

/** Seconds at the start of each round when everyone is still around the table. */
export const TABLE_SEC = 7;

/** "I saw X in this area from..to". One entry per continuous stretch in one area. */
export interface Sighting {
  /** Who the agent *thinks* it saw (rookies sometimes get this wrong). */
  playerId: PlayerId;
  areaId: string | null;
  from: number;
  to: number;
  /** Station they were standing at working, if any. */
  working: string | null;
  /** Closest distance during the sighting (could they see me back?). */
  closest: number;
}

export interface BodyNote {
  bodyId: string;
  victimId: PlayerId;
  areaId: string | null;
  tick: number;
  /** Living players seen within a few tiles when the body was found. */
  nearby: PlayerId[];
  /** Set when the agent saw the victim alive a moment before and one person standing on the body. */
  killer: PlayerId | null;
}

export interface TrailStep {
  areaId: string | null;
  from: number;
  to: number;
}

export interface KillNote {
  victimId: PlayerId;
  areaId: string | null;
  tick: number;
}

export interface MeetingRecord {
  index: number;
  /** The round this meeting ended. */
  round: number;
  reason: MeetingReason;
  calledBy: PlayerId;
  victimId: PlayerId | null;
  bodyAreaId: string | null;
  startTick: number;
  chat: ChatMessage[];
  result: MeetingResult | null;
}

/**
 * Everything one agent remembers, built only from its own observations.
 * The tier decides how much slips through: rookies miss people and mix them up.
 */
export class Memory {
  readonly sightings: Sighting[] = [];
  readonly bodies: BodyNote[] = [];
  readonly trail: TrailStep[] = [];
  readonly kills: KillNote[] = [];
  readonly meetings: MeetingRecord[] = [];
  /** Tick each round started (index = round - 1). */
  readonly roundStarts: number[] = [];
  private readonly open = new Map<PlayerId, Sighting>();
  private readonly missed = new Set<PlayerId>();
  private readonly seenBodies = new Set<string>();
  private prevVisible = new Set<PlayerId>();
  private round = 0;

  constructor(
    private readonly selfId: PlayerId,
    private readonly tier: TierProfile,
    private readonly rng: Rng,
  ) {}

  observe(obs: Observation): void {
    if (obs.phase === 'meeting') {
      this.closeAll();
      this.recordMeeting(obs);
      return;
    }
    if (obs.phase !== 'playing') {
      this.closeAll();
      return;
    }
    const t = obs.tick;
    if (obs.round !== this.round) {
      this.round = obs.round;
      this.roundStarts[obs.round - 1] = obs.roundStartTick;
      this.closeAll();
    }

    const last = this.trail.at(-1);
    if (last && last.areaId === obs.self.areaId && t - last.to <= 1) last.to = t;
    else this.trail.push({ areaId: obs.self.areaId, from: t, to: t });

    const visible = obs.visiblePlayers.filter((v) => (obs.self.alive ? v.alive : true));
    const ids = new Set(visible.map((v) => v.id));
    // Everyone starts each round at the meeting table, so the first moments tell you nothing.
    const atTable = t - this.currentRoundStart < secToTicks(TABLE_SEC);
    for (const v of visible) {
      if (this.missed.has(v.id) || atTable) continue;
      const d = dist(v.pos, obs.self.pos);
      const s = this.open.get(v.id);
      if (!s) {
        if (this.tier.missChance > 0 && this.rng.chance(this.tier.missChance)) {
          this.missed.add(v.id); // didn't notice them this time they came into view
          continue;
        }
        const who = this.tier.mixupChance > 0 && this.rng.chance(this.tier.mixupChance) ? this.mixUp(obs, v.id) : v.id;
        this.startSighting(v.id, { playerId: who, areaId: v.areaId, from: t, to: t, working: v.workingAt, closest: d });
      } else if (s.areaId !== v.areaId) {
        this.startSighting(v.id, { playerId: s.playerId, areaId: v.areaId, from: t, to: t, working: v.workingAt, closest: d });
      } else {
        s.to = t;
        if (v.workingAt) s.working = v.workingAt;
        s.closest = Math.min(s.closest, d);
      }
    }
    for (const id of [...this.open.keys()]) if (!ids.has(id)) this.open.delete(id);
    for (const id of [...this.missed]) if (!ids.has(id)) this.missed.delete(id);

    if (obs.self.alive && !atTable) {
      for (const b of obs.visibleBodies) {
        if (this.seenBodies.has(b.id)) continue;
        this.seenBodies.add(b.id);
        const noticed = visible.filter((v) => v.alive && this.open.has(v.id));
        const recall = (id: PlayerId) => this.open.get(id)?.playerId ?? id;
        const onTop = noticed.filter((v) => dist(v.pos, b.pos) <= 1.2);
        this.bodies.push({
          bodyId: b.id,
          victimId: b.victimId,
          areaId: b.areaId,
          tick: t,
          nearby: noticed.filter((v) => dist(v.pos, b.pos) <= 4).map((v) => recall(v.id)),
          killer: this.prevVisible.has(b.victimId) && onTop.length === 1 ? recall(onTop[0].id) : null,
        });
      }
    }
    this.prevVisible = new Set(visible.filter((v) => v.alive && this.open.has(v.id)).map((v) => v.id));
  }

  /** Called by the agent when its own kill succeeds. */
  noteKill(victimId: PlayerId, areaId: string | null, tick: number): void {
    this.kills.push({ victimId, areaId, tick });
  }

  /** Sightings a player of this tier still remembers at `now`. Most recent first. */
  recall(now: number, tickRate: number): Sighting[] {
    const span = this.tier.memorySpanSec;
    return this.sightings
      .filter((s) => span === null || now - s.to <= span * tickRate)
      .sort((a, b) => b.to - a.to)
      .slice(0, this.tier.maxSightings);
  }

  get currentRoundStart(): number {
    return this.roundStarts[this.round - 1] ?? 0;
  }

  private startSighting(key: PlayerId, s: Sighting): void {
    this.open.set(key, s);
    this.sightings.push(s);
  }

  private closeAll(): void {
    this.open.clear();
    this.missed.clear();
    this.prevVisible.clear();
  }

  private mixUp(obs: Observation, actual: PlayerId): PlayerId {
    const others = obs.roster.filter((r) => r.id !== actual && r.id !== this.selfId && !r.knownDead).map((r) => r.id);
    return others.length > 0 ? this.rng.pick(others) : actual;
  }

  private recordMeeting(obs: Observation): void {
    const m = obs.meeting;
    if (!m) return;
    let rec = this.meetings.find((r) => r.index === m.index);
    if (!rec) {
      rec = { index: m.index, round: obs.round, reason: m.reason, calledBy: m.calledBy, victimId: m.victimId, bodyAreaId: m.bodyAreaId, startTick: obs.tick, chat: [], result: null };
      this.meetings.push(rec);
    }
    rec.chat = m.chat;
    if (m.result) rec.result = m.result;
  }
}

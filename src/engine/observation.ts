import { ticksToSec } from './config';
import type { Vec2 } from './geometry';
import type { Game } from './game';
import type {
  ChatMessage,
  GameResult,
  MeetingReason,
  MeetingResult,
  MeetingStage,
  Phase,
  PlayerId,
  PlayerState,
  PlayerTask,
  Role,
  VoteTarget,
} from './types';

export interface VisiblePlayer {
  id: PlayerId;
  pos: Vec2;
  areaId: string | null;
  /** Station they're standing at working (real or faked). Nobody can tell which. */
  workingAt: string | null;
  alive: boolean;
}

export interface VisibleBody {
  id: string;
  victimId: PlayerId;
  pos: Vec2;
  areaId: string | null;
}

export interface RosterEntry {
  id: PlayerId;
  name: string;
  color: string;
  /** Dead as far as this player knows (revealed at meetings, or yourself). */
  knownDead: boolean;
}

export interface SelfView {
  id: PlayerId;
  name: string;
  role: Role;
  alive: boolean;
  pos: Vec2;
  areaId: string | null;
  tasks: PlayerTask[];
  busy: { stationId: string; secLeft: number } | null;
  /** Saboteurs only. */
  killCooldownSec: number | null;
  emergencyLeft: number;
}

export interface MeetingView {
  index: number;
  reason: MeetingReason;
  calledBy: PlayerId;
  victimId: PlayerId | null;
  bodyAreaId: string | null;
  stage: MeetingStage;
  secLeft: number;
  participants: PlayerId[];
  chat: ChatMessage[];
  /** Who has voted (not for whom) until the result is in. */
  voted: PlayerId[];
  myVote: VoteTarget | null;
  result: MeetingResult | null;
}

/**
 * Everything one player is allowed to know at this moment.
 * Bots and AI agents decide only from this, never from the full game state,
 * so they can't cheat.
 */
export interface Observation {
  tick: number;
  timeSec: number;
  phase: Phase;
  round: number;
  /** Tick the current round began. Public: everyone sees the meeting end. */
  roundStartTick: number;
  self: SelfView;
  /** Fellow saboteurs (empty for crew). */
  saboteurTeam: PlayerId[];
  roster: RosterEntry[];
  visiblePlayers: VisiblePlayer[];
  visibleBodies: VisibleBody[];
  /** Crew task bar, 0..1. Everyone sees it. */
  taskProgress: number;
  buttonReadyInSec: number;
  meeting: MeetingView | null;
  result: GameResult | null;
}

export function buildObservation(game: Game, me: PlayerState): Observation {
  const s = game.state;
  const { nav } = game;
  const visiblePlayers: VisiblePlayer[] = [];
  const visibleBodies: VisibleBody[] = [];

  if (s.phase === 'playing') {
    for (const other of s.players) {
      if (other.id === me.id) continue;
      if (!other.alive && me.alive) continue; // the living can't see ghosts
      if (!game.canSee(me, other.pos)) continue;
      visiblePlayers.push({
        id: other.id,
        pos: { ...other.pos },
        areaId: nav.areaAt(other.pos)?.id ?? null,
        workingAt: other.busy?.stationId ?? null,
        alive: other.alive,
      });
    }
    for (const b of s.bodies) {
      if (game.canSee(me, b.pos)) visibleBodies.push({ id: b.id, victimId: b.victimId, pos: { ...b.pos }, areaId: b.areaId });
    }
  }

  const knownDead = new Set(s.publicDead);
  if (!me.alive) knownDead.add(me.id);
  const progress = game.taskProgress();
  const m = s.meeting;

  return {
    tick: s.tick,
    timeSec: ticksToSec(s.tick),
    phase: s.phase,
    round: s.round,
    roundStartTick: s.roundStartTick,
    self: {
      id: me.id,
      name: me.name,
      role: me.role,
      alive: me.alive,
      pos: { ...me.pos },
      areaId: nav.areaAt(me.pos)?.id ?? null,
      tasks: me.tasks.map((t) => ({ ...t })),
      busy: me.busy ? { stationId: me.busy.stationId, secLeft: ticksToSec(me.busy.untilTick - s.tick) } : null,
      killCooldownSec: me.role === 'saboteur' ? ticksToSec(me.killCooldownTicks) : null,
      emergencyLeft: me.emergencyLeft,
    },
    saboteurTeam:
      me.role === 'saboteur' ? s.players.filter((p) => p.role === 'saboteur' && p.id !== me.id).map((p) => p.id) : [],
    roster: s.players.map((p) => ({ id: p.id, name: p.name, color: p.color, knownDead: knownDead.has(p.id) })),
    visiblePlayers,
    visibleBodies,
    taskProgress: progress.total ? progress.done / progress.total : 0,
    buttonReadyInSec: Math.max(0, ticksToSec(s.buttonReadyTick - s.tick)),
    meeting: m
      ? {
          index: m.index,
          reason: m.reason,
          calledBy: m.calledBy,
          victimId: m.victimId,
          bodyAreaId: m.bodyAreaId,
          stage: m.stage,
          secLeft: Math.max(0, ticksToSec(m.stageEndsTick - s.tick)),
          participants: [...m.participants],
          chat: m.chat.map((c) => ({ ...c, ...(c.claims ? { claims: c.claims.map((k) => ({ ...k, saw: [...k.saw] })) } : {}) })),
          voted: m.participants.filter((id) => m.votes[id] !== undefined),
          myVote: m.votes[me.id] ?? null,
          result: m.result ? { ...m.result, tally: { ...m.result.tally }, votes: { ...m.result.votes } } : null,
        }
      : null,
    result: s.result ? { ...s.result } : null,
  };
}

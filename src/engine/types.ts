import type { Vec2 } from './geometry';

export type PlayerId = string;
export type Role = 'crew' | 'saboteur';
export type Phase = 'playing' | 'meeting' | 'ended';
export type MeetingStage = 'discussion' | 'voting' | 'result';
export type MeetingReason = 'body' | 'emergency';
export type VoteTarget = PlayerId | 'skip';

export interface PlayerSetup {
  id: PlayerId;
  name: string;
  color: string;
  /** Force a role (handy in tests). Unset roles are dealt randomly. */
  role?: Role;
}

export interface PlayerTask {
  stationId: string;
  done: boolean;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  role: Role;
  alive: boolean;
  ejected: boolean;
  diedAtTick: number | null;
  pos: Vec2;
  /** Current movement intent, length ≤ 1. Null = standing still. */
  move: Vec2 | null;
  killCooldownTicks: number;
  /** Saboteurs get fake tasks so they can pretend; theirs never count. */
  tasks: PlayerTask[];
  busy: { stationId: string; untilTick: number } | null;
  emergencyLeft: number;
}

export interface BodyState {
  id: string;
  victimId: PlayerId;
  pos: Vec2;
  areaId: string | null;
  tick: number;
}

/** A structured "I was here and saw these people" statement attached to a chat line. */
export interface Claim {
  areaId: string;
  /** When the speaker says they were there, if they said. */
  atTick: number | null;
  saw: PlayerId[];
}

export interface ChatMessage {
  tick: number;
  playerId: PlayerId;
  text: string;
  /** Optional structured accusation, so bots and the AI notebook can read it. */
  accuse?: PlayerId;
  /** Optional structured whereabouts claims, checked against sightings by the AI notebook. */
  claims?: Claim[];
}

export interface MeetingResult {
  ejectedId: PlayerId | null;
  tie: boolean;
  /** Vote counts by target id, plus 'skip'. */
  tally: Record<string, number>;
  votes: Record<PlayerId, VoteTarget>;
  /** Only set when confirmEjects is on. */
  revealedRole: Role | null;
}

export interface MeetingState {
  index: number;
  reason: MeetingReason;
  calledBy: PlayerId;
  victimId: PlayerId | null;
  bodyAreaId: string | null;
  /** Players alive when the meeting began; only they can talk and vote. */
  participants: PlayerId[];
  stage: MeetingStage;
  startTick: number;
  stageEndsTick: number;
  votes: Record<PlayerId, VoteTarget>;
  chat: ChatMessage[];
  result: MeetingResult | null;
}

export type Winner = 'crew' | 'saboteurs' | 'none';
export type WinReason = 'tasks' | 'saboteurs_ejected' | 'parity' | 'timeout';

export interface GameResult {
  winner: Winner;
  reason: WinReason;
  tick: number;
}

export interface GameState {
  tick: number;
  phase: Phase;
  round: number;
  /** Tick the current round began (0, then the end of each meeting). */
  roundStartTick: number;
  players: PlayerState[];
  bodies: BodyState[];
  meeting: MeetingState | null;
  meetingsHeld: number;
  buttonReadyTick: number;
  /** Deaths everyone knows about (revealed at meetings). */
  publicDead: PlayerId[];
  result: GameResult | null;
  nextBodyId: number;
}

export type Action =
  | { type: 'start_task'; stationId: string }
  | { type: 'kill'; targetId: PlayerId }
  | { type: 'report'; bodyId: string }
  | { type: 'call_meeting' }
  | { type: 'chat'; text: string; accuse?: PlayerId; claims?: Claim[] }
  | { type: 'vote'; target: VoteTarget };

export type ActionResult = { ok: true } | { ok: false; reason: string };

/** Everything that happens, in order. This is the omniscient log used for replays and the post-game reveal. */
export type GameEventBody =
  | { type: 'game_started'; roles: Record<PlayerId, Role> }
  | { type: 'task_started'; playerId: PlayerId; stationId: string }
  | { type: 'task_completed'; playerId: PlayerId; stationId: string; fake: boolean }
  | { type: 'task_cancelled'; playerId: PlayerId; stationId: string }
  | { type: 'kill'; killerId: PlayerId; victimId: PlayerId; bodyId: string; pos: Vec2; areaId: string | null }
  | { type: 'meeting_called'; reason: MeetingReason; callerId: PlayerId; victimId: PlayerId | null; bodyAreaId: string | null }
  | { type: 'voting_started' }
  | { type: 'chat'; playerId: PlayerId; text: string; accuse?: PlayerId; claims?: Claim[] }
  | { type: 'vote_cast'; voterId: PlayerId; target: VoteTarget }
  | { type: 'meeting_result'; result: MeetingResult }
  | { type: 'round_started'; round: number }
  | { type: 'game_over'; result: GameResult };

export type GameEvent = GameEventBody & { tick: number };

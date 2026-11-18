import { NavGrid, type GameConfig, type GameResult, type MapDef, type Observation, type PlayerId, type Role } from '../../src/engine';
import type { VoiceSpec } from '../../src/shared/protocol';

/** Everything the browser knows. Built only from what the server sends. */
export interface ClientState {
  you: PlayerId | null;
  map: MapDef | null;
  nav: NavGrid | null;
  config: GameConfig | null;
  obs: Observation | null;
  /** When the latest observation arrived (ms). */
  obsAt: number;
  model: string;
  fake: boolean;
  /** AI players composing a meeting line, until when (ms). */
  typing: Map<PlayerId, number>;
  /** How each AI sounds. */
  voices: Record<PlayerId, VoiceSpec>;
  over: { result: GameResult; roles: Record<PlayerId, Role>; reveal: string } | null;
}

export function newState(): ClientState {
  return { you: null, map: null, nav: null, config: null, obs: null, obsAt: 0, model: '', fake: false, typing: new Map(), voices: {}, over: null };
}

export function setMap(s: ClientState, map: MapDef, config: GameConfig, you: PlayerId, voices: Record<PlayerId, VoiceSpec>): void {
  s.voices = voices;
  s.map = map;
  s.nav = new NavGrid(map);
  s.config = config;
  s.you = you;
  s.obs = null;
  s.over = null;
  s.typing.clear();
}

export function nameOf(s: ClientState, id: PlayerId): string {
  return s.obs?.roster.find((r) => r.id === id)?.name ?? id;
}

export function colorOf(s: ClientState, id: PlayerId): string {
  return s.obs?.roster.find((r) => r.id === id)?.color ?? 'grey';
}

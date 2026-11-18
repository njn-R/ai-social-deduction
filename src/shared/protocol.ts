import type { Action, GameConfig, GameResult, MapDef, Observation, PlayerId, Role, Vec2 } from '../engine';

export type RoleChoice = 'random' | 'crew' | 'saboteur';

/**
 * How one AI sounds. Text-to-speech runs in the browser; each engine reads the field it
 * understands, so another engine (e.g. Fish Audio) can be added beside Kokoro later.
 */
export interface VoiceSpec {
  /** Kokoro voice id, e.g. "af_heart". */
  kokoro: string;
  /** Speaking speed, 1 = normal. */
  speed: number;
}

/** Browser -> server. */
export type ClientMessage =
  | { type: 'start'; name: string; role: RoleChoice }
  | { type: 'move'; dir: Vec2 | null }
  /** Any engine action (tasks, kills, reports, the button, votes). The server validates it. */
  | { type: 'act'; action: Action }
  /** Typed meeting chat; the server turns it into a chat action. */
  | { type: 'chat'; text: string }
  /** The human is typing a message (sent about once a second while they type). */
  | { type: 'typing' }
  /** The browser is behind on reading AI lines aloud (on), or ready for the next line (off). */
  | { type: 'speaking'; on: boolean }
  /** Whether AI lines are being read aloud at all (voices on and loaded). */
  | { type: 'voice'; on: boolean }
  /** Done reading the role screen: start the game now. */
  | { type: 'ready' };

/** Server -> browser. Only ever what the human player is allowed to know. */
export type ServerMessage =
  | { type: 'hello'; model: string; fake: boolean }
  | { type: 'welcome'; you: PlayerId; map: MapDef; config: GameConfig; voices: Record<PlayerId, VoiceSpec> }
  | { type: 'obs'; obs: Observation }
  /** An AI started (on) or finished (off) composing a meeting line. */
  | { type: 'typing'; playerId: PlayerId; on: boolean }
  /** A rejected action or other short message for the player. */
  | { type: 'notice'; text: string }
  | { type: 'game_over'; result: GameResult; roles: Record<PlayerId, Role>; reveal: string }
  /** A new game was started from another tab or window; this one should go quiet. */
  | { type: 'taken' }
  /** The game is paused for this long so you can see your role; send 'ready' to start sooner. */
  | { type: 'intro'; seconds: number }
  | { type: 'error'; message: string };

/** Simulation ticks per second of game time. */
export const TICK_RATE = 20;

export const secToTicks = (sec: number): number => Math.round(sec * TICK_RATE);
export const ticksToSec = (ticks: number): number => ticks / TICK_RATE;

export interface GameConfig {
  saboteurs: number;
  /** Tiles per second. */
  playerSpeed: number;
  /** Vision radius in tiles. Saboteurs see further than crew. */
  crewVision: number;
  saboteurVision: number;
  killRange: number;
  reportRange: number;
  taskRange: number;
  buttonRange: number;
  killCooldownSec: number;
  /** Kill cooldown at the very start of the game (shorter than the normal one). */
  initialKillCooldownSec: number;
  shortTasks: number;
  longTasks: number;
  shortTaskSec: number;
  longTaskSec: number;
  emergencyMeetingsPerPlayer: number;
  /** The button can't be pressed for this long after each round starts. */
  emergencyCooldownSec: number;
  discussionSec: number;
  votingSec: number;
  /** How long the vote result is shown before play resumes. */
  resultSec: number;
  /** Reveal the ejected player's role. */
  confirmEjects: boolean;
  /** Dead crew keep doing tasks as ghosts (needed so task wins stay reachable). */
  ghostsDoTasks: boolean;
  /** Safety limit so a stuck game always ends. */
  maxGameSec: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  saboteurs: 2,
  playerSpeed: 4.5,
  crewVision: 7,
  saboteurVision: 9,
  killRange: 1.6,
  reportRange: 2.5,
  taskRange: 1.2,
  buttonRange: 2,
  killCooldownSec: 25,
  initialKillCooldownSec: 10,
  shortTasks: 3,
  longTasks: 2,
  shortTaskSec: 3,
  longTaskSec: 8,
  emergencyMeetingsPerPlayer: 1,
  emergencyCooldownSec: 15,
  discussionSec: 90,
  votingSec: 30,
  resultSec: 5,
  confirmEjects: true,
  ghostsDoTasks: true,
  maxGameSec: 1200,
};

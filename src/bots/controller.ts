import type { Action, ActionResult, Observation, PlayerId, Vec2 } from '../engine';

/** What a controller may do to its own player. */
export interface ControlApi {
  setMove(dir: Vec2 | null): void;
  act(action: Action): ActionResult;
}

/**
 * Anything that drives a player: scripted bots now, LLM agents in Phase 2,
 * the human's input in Phase 3. Called once per tick with a fresh observation.
 */
export interface Controller {
  readonly id: PlayerId;
  update(obs: Observation, api: ControlApi): void;
}

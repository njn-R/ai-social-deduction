import { dist, length, normalize, scale, sub, type NavGrid, type Vec2 } from '../engine';

/**
 * Reflex-layer walking: plan a path to a goal and steer along it tick by tick.
 * Shared by scripted bots and (later) LLM agents, so the LLM only ever picks
 * *where* to go, never how to walk there.
 */
export class Navigator {
  private path: Vec2[] = [];
  private goal: Vec2 | null = null;
  private lastPos: Vec2 | null = null;
  private stuckTicks = 0;

  /** @param stepPerTick distance a player covers in one tick at full speed */
  constructor(
    private readonly nav: NavGrid,
    private readonly stepPerTick: number,
  ) {}

  get currentGoal(): Vec2 | null {
    return this.goal;
  }

  /** True once the goal has been reached. */
  get arrived(): boolean {
    return this.goal !== null && this.path.length === 0;
  }

  /**
   * Head for `goal`. Keeps the current path if the goal moved less than
   * `tolerance` tiles (so chasing a moving target doesn't replan every tick).
   * Returns false when there is no route.
   */
  setGoal(goal: Vec2, from: Vec2, tolerance = 0.01): boolean {
    if (this.goal && dist(this.goal, goal) <= tolerance && (this.path.length > 0 || dist(from, goal) < 1e-3)) return true;
    const path = this.nav.findPath(from, goal);
    this.stuckTicks = 0;
    if (!path) {
      this.clear();
      return false;
    }
    this.goal = { ...goal };
    this.path = path;
    return true;
  }

  clear(): void {
    this.goal = null;
    this.path = [];
    this.lastPos = null;
    this.stuckTicks = 0;
  }

  /** Movement intent for this tick, or null when there's nowhere left to go. */
  steer(pos: Vec2): Vec2 | null {
    while (this.path.length > 0 && dist(pos, this.path[0]) < 1e-3) this.path.shift();
    if (this.path.length === 0 || !this.goal) return null;

    if (this.lastPos && dist(this.lastPos, pos) < 1e-4) {
      if (++this.stuckTicks > 8) {
        const repath = this.nav.findPath(pos, this.goal);
        this.stuckTicks = 0;
        if (!repath) {
          this.clear();
          return null;
        }
        this.path = repath;
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastPos = { ...pos };

    const toNext = sub(this.path[0], pos);
    // Ease in on the waypoint so we land on it exactly instead of overshooting.
    const magnitude = Math.min(1, length(toNext) / this.stepPerTick);
    return scale(normalize(toNext), magnitude);
  }
}

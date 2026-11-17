import type { Vec2 } from '../geometry';
import type { AreaDef, MapDef, StationDef } from './types';

const SQRT2 = Math.SQRT2;
const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/**
 * Tile grid built from a MapDef. Answers the spatial questions the engine and
 * the AI need: is this spot floor, which area is it in, can A see B, and how
 * do I walk from A to B.
 */
export class NavGrid {
  readonly width: number;
  readonly height: number;
  private readonly walkable: Uint8Array;
  private readonly areaIndex: Int16Array;
  private readonly areaById = new Map<string, AreaDef>();
  private readonly stationById = new Map<string, StationDef>();

  constructor(readonly map: MapDef) {
    this.width = map.width;
    this.height = map.height;
    const n = this.width * this.height;
    this.walkable = new Uint8Array(n);
    this.areaIndex = new Int16Array(n).fill(-1);

    // Halls first, then rooms, so a room wins any overlapping cell.
    const ordered = map.areas
      .map((a, i) => [a, i] as const)
      .sort(([a], [b]) => (a.kind === b.kind ? 0 : a.kind === 'hall' ? -1 : 1));
    for (const [area, index] of ordered) {
      const { x, y, w, h } = area.rect;
      if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) {
        throw new Error(`Area ${area.id} is outside the ${this.width}x${this.height} map`);
      }
      if (this.areaById.has(area.id)) throw new Error(`Duplicate area id ${area.id}`);
      this.areaById.set(area.id, area);
      for (let cy = y; cy < y + h; cy++) {
        for (let cx = x; cx < x + w; cx++) {
          this.walkable[cy * this.width + cx] = 1;
          this.areaIndex[cy * this.width + cx] = index;
        }
      }
    }
    for (const s of map.stations) {
      if (this.stationById.has(s.id)) throw new Error(`Duplicate station id ${s.id}`);
      this.stationById.set(s.id, s);
    }
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  isWalkableCell(cx: number, cy: number): boolean {
    return this.inBounds(cx, cy) && this.walkable[cy * this.width + cx] === 1;
  }

  isWalkable(p: Vec2): boolean {
    return this.isWalkableCell(Math.floor(p.x), Math.floor(p.y));
  }

  areaAt(p: Vec2): AreaDef | null {
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (!this.inBounds(cx, cy)) return null;
    const i = this.areaIndex[cy * this.width + cx];
    return i >= 0 ? this.map.areas[i] : null;
  }

  area(id: string): AreaDef {
    const a = this.areaById.get(id);
    if (!a) throw new Error(`Unknown area ${id}`);
    return a;
  }

  station(id: string): StationDef {
    const s = this.stationById.get(id);
    if (!s) throw new Error(`Unknown station ${id}`);
    return s;
  }

  rooms(): AreaDef[] {
    return this.map.areas.filter((a) => a.kind === 'room');
  }

  areaCenter(id: string): Vec2 {
    const { x, y, w, h } = this.area(id).rect;
    return { x: x + w / 2, y: y + h / 2 };
  }

  /**
   * True when the straight segment a→b only crosses floor cells.
   * Used both for vision and for "can I walk straight there".
   * Grid traversal (Amanatides & Woo); a segment passing exactly through a
   * corner needs both side cells open, so you can't see through diagonal gaps.
   */
  hasLineOfSight(a: Vec2, b: Vec2): boolean {
    let cx = Math.floor(a.x);
    let cy = Math.floor(a.y);
    const ex = Math.floor(b.x);
    const ey = Math.floor(b.y);
    if (!this.isWalkableCell(cx, cy) || !this.isWalkableCell(ex, ey)) return false;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? cx + 1 - a.x : a.x - cx) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? cy + 1 - a.y : a.y - cy) * tDeltaY : Infinity;

    let guard = this.width + this.height + 4;
    while ((cx !== ex || cy !== ey) && guard-- > 0) {
      if (Math.min(tMaxX, tMaxY) > 1 + 1e-9) break; // float drift past the end point
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else if (tMaxY < tMaxX) {
        tMaxY += tDeltaY;
        cy += stepY;
      } else {
        if (!this.isWalkableCell(cx + stepX, cy) || !this.isWalkableCell(cx, cy + stepY)) return false;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
        cx += stepX;
        cy += stepY;
      }
      if (!this.isWalkableCell(cx, cy)) return false;
    }
    return true;
  }

  /**
   * A* over the tile grid (8 directions, no corner cutting), then smoothed so
   * the path only turns where it has to. Returns the waypoints after `from`,
   * ending exactly at `to`, or null when there is no route.
   */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const sx = Math.floor(from.x);
    const sy = Math.floor(from.y);
    const gx = Math.floor(to.x);
    const gy = Math.floor(to.y);
    if (!this.isWalkableCell(sx, sy) || !this.isWalkableCell(gx, gy)) return null;
    if (sx === gx && sy === gy) return [{ ...to }];

    const W = this.width;
    const N = W * this.height;
    const start = sy * W + sx;
    const goal = gy * W + gx;
    const gScore = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = new MinHeap();
    gScore[start] = 0;
    open.push(start, octile(sx, sy, gx, gy));

    while (open.size > 0) {
      const cur = open.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % W;
      const cy = (cur - cx) / W;
      for (const [dx, dy, cost] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isWalkableCell(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!this.isWalkableCell(cx + dx, cy) || !this.isWalkableCell(cx, cy + dy))) continue;
        const ni = ny * W + nx;
        if (closed[ni]) continue;
        const g = gScore[cur] + cost;
        if (g < gScore[ni]) {
          gScore[ni] = g;
          came[ni] = cur;
          open.push(ni, g + octile(nx, ny, gx, gy));
        }
      }
    }
    if (came[goal] === -1) return null;

    const cells: number[] = [];
    for (let c = goal; c !== start; c = came[c]) cells.push(c);
    cells.reverse();
    const points: Vec2[] = [{ ...from }, ...cells.map((c) => ({ x: (c % W) + 0.5, y: Math.floor(c / W) + 0.5 }))];
    points[points.length - 1] = { ...to };
    return this.smooth(points);
  }

  /** Total walking distance from `from` along `path`. */
  static pathLength(from: Vec2, path: readonly Vec2[]): number {
    let total = 0;
    let prev = from;
    for (const p of path) {
      total += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    return total;
  }

  private smooth(points: Vec2[]): Vec2[] {
    const out: Vec2[] = [];
    let i = 0;
    while (i < points.length - 1) {
      let j = i + 1;
      while (j + 1 < points.length && this.hasLineOfSight(points[i], points[j + 1])) j++;
      out.push(points[j]);
      i = j;
    }
    return out;
  }
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

class MinHeap {
  private items: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, prio: number): void {
    const { items, prios } = this;
    items.push(item);
    prios.push(prio);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prios[parent] <= prios[i]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      [prios[parent], prios[i]] = [prios[i], prios[parent]];
      i = parent;
    }
  }

  pop(): number {
    const { items, prios } = this;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastPrio = prios.pop()!;
    if (items.length > 0) {
      items[0] = lastItem;
      prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && prios[l] < prios[m]) m = l;
        if (r < items.length && prios[r] < prios[m]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        [prios[m], prios[i]] = [prios[i], prios[m]];
        i = m;
      }
    }
    return top;
  }
}

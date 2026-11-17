import type { Vec2 } from '../geometry';

/** Axis-aligned rectangle in whole tiles: covers cells x..x+w-1, y..y+h-1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AreaKind = 'room' | 'hall';

/** A named walkable region. The walkable floor is the union of all areas. */
export interface AreaDef {
  id: string;
  name: string;
  kind: AreaKind;
  rect: Rect;
}

export type TaskKind = 'short' | 'long';

/** A place where a task is done. */
export interface StationDef {
  id: string;
  name: string;
  areaId: string;
  pos: Vec2;
  kind: TaskKind;
}

export interface MapDef {
  id: string;
  name: string;
  width: number;
  height: number;
  areas: AreaDef[];
  stations: StationDef[];
  /** Emergency meeting button. */
  button: { areaId: string; pos: Vec2 };
  /** Where players stand at game start and after each meeting. Needs one per player. */
  seats: Vec2[];
}

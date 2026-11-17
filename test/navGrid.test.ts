import { describe, expect, it } from 'vitest';
import { NavGrid, STATION_MAP, type Vec2 } from '../src/engine';
import { TWO_ROOMS } from './helpers';

const nav = new NavGrid(STATION_MAP);

describe('station map', () => {
  it('puts every station, seat and the button on floor, in the right area', () => {
    for (const s of STATION_MAP.stations) {
      expect(nav.isWalkable(s.pos), s.id).toBe(true);
      expect(nav.areaAt(s.pos)?.id, s.id).toBe(s.areaId);
    }
    for (const seat of STATION_MAP.seats) expect(nav.areaAt(seat)?.id).toBe('commons');
    expect(nav.areaAt(STATION_MAP.button.pos)?.id).toBe(STATION_MAP.button.areaId);
  });

  it('lets you walk from the meeting table to every station along clear segments', () => {
    const from = STATION_MAP.seats[0];
    for (const s of STATION_MAP.stations) {
      const path = nav.findPath(from, s.pos);
      expect(path, s.id).not.toBeNull();
      let prev: Vec2 = from;
      for (const p of path!) {
        expect(nav.hasLineOfSight(prev, p), `${s.id} segment`).toBe(true);
        prev = p;
      }
      expect(path!.at(-1)).toEqual(s.pos);
    }
  });

  it('connects every room to every other room', () => {
    const rooms = nav.rooms();
    for (const a of rooms) for (const b of rooms) {
      expect(nav.findPath(nav.areaCenter(a.id), nav.areaCenter(b.id)), `${a.id} -> ${b.id}`).not.toBeNull();
    }
  });

  it('names corridors as halls', () => {
    expect(nav.areaAt({ x: 20, y: 6 })).toMatchObject({ id: 'hall-dome-sonar', kind: 'hall' });
    expect(nav.areaAt({ x: 20, y: 12 })).toBeNull();
  });

  it('blocks sight through walls but not across open floor', () => {
    expect(nav.hasLineOfSight({ x: 26.5, y: 17.5 }, { x: 37.5, y: 27.5 })).toBe(true); // across Commons
    expect(nav.hasLineOfSight({ x: 27.5, y: 10.5 }, { x: 27.5, y: 16.5 })).toBe(false); // Sonar to Commons through the wall
    expect(nav.hasLineOfSight({ x: 9, y: 7 }, { x: 32, y: 22.5 })).toBe(false); // Dome to Commons diagonally
  });

  it('refuses paths that start or end inside a wall', () => {
    expect(nav.findPath({ x: 26.5, y: 18.5 }, { x: 20, y: 12 })).toBeNull();
  });
});

describe('a one-tile wall', () => {
  const small = new NavGrid(TWO_ROOMS);

  it('blocks sight even when the rooms are an arm-length apart', () => {
    expect(small.hasLineOfSight({ x: 4.9, y: 1.5 }, { x: 6.1, y: 1.5 })).toBe(false);
  });

  it('makes you walk around through the door', () => {
    const from = { x: 4.5, y: 1.5 };
    const to = { x: 6.5, y: 1.5 };
    const path = small.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(NavGrid.pathLength(from, path)).toBeGreaterThan(6);
  });
});

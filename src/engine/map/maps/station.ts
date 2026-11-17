import type { Vec2 } from '../../geometry';
import type { AreaDef, MapDef, StationDef } from '../types';

/**
 * Placeholder map: a 3x3 grid of rooms joined by corridors.
 * Names are a stand-in deep-sea theme; swap them freely once the theme is picked.
 *
 *   Observation Dome ── Sonar ── Lab
 *          │             │        │
 *     Hydroponics ──  Commons ── Infirmary
 *          │             │        │
 *      Generator  ──  Galley  ── Ballast Control
 */
const room = (id: string, name: string, x: number, y: number, w: number, h: number): AreaDef => ({
  id, name, kind: 'room', rect: { x, y, w, h },
});
const hall = (id: string, name: string, x: number, y: number, w: number, h: number): AreaDef => ({
  id, name, kind: 'hall', rect: { x, y, w, h },
});

const areas: AreaDef[] = [
  room('dome', 'Observation Dome', 3, 2, 12, 10),
  room('sonar', 'Sonar', 26, 2, 12, 10),
  room('lab', 'Lab', 49, 2, 12, 10),
  room('hydro', 'Hydroponics', 3, 18, 12, 10),
  room('commons', 'Commons', 24, 16, 16, 13),
  room('infirmary', 'Infirmary', 49, 18, 12, 10),
  room('generator', 'Generator', 3, 34, 12, 10),
  room('galley', 'Galley', 26, 34, 12, 10),
  room('ballast', 'Ballast Control', 49, 34, 12, 10),

  hall('hall-dome-sonar', 'Dome-Sonar corridor', 15, 5, 11, 3),
  hall('hall-sonar-lab', 'Sonar-Lab corridor', 38, 5, 11, 3),
  hall('hall-hydro-commons', 'Hydroponics-Commons corridor', 15, 21, 9, 3),
  hall('hall-commons-infirmary', 'Commons-Infirmary corridor', 40, 21, 9, 3),
  hall('hall-generator-galley', 'Generator-Galley corridor', 15, 37, 11, 3),
  hall('hall-galley-ballast', 'Galley-Ballast corridor', 38, 37, 11, 3),
  hall('hall-dome-hydro', 'Dome-Hydroponics corridor', 7, 12, 3, 6),
  hall('hall-sonar-commons', 'Sonar-Commons corridor', 30, 12, 3, 4),
  hall('hall-lab-infirmary', 'Lab-Infirmary corridor', 53, 12, 3, 6),
  hall('hall-hydro-generator', 'Hydroponics-Generator corridor', 7, 28, 3, 6),
  hall('hall-commons-galley', 'Commons-Galley corridor', 30, 29, 3, 5),
  hall('hall-infirmary-ballast', 'Infirmary-Ballast corridor', 53, 28, 3, 6),
];

const st = (id: string, name: string, areaId: string, x: number, y: number, kind: 'short' | 'long'): StationDef => ({
  id, name, areaId, pos: { x, y }, kind,
});

const stations: StationDef[] = [
  st('dome-camera', 'Recalibrate depth camera', 'dome', 5.5, 3.5, 'long'),
  st('dome-viewport', 'Wipe viewport sensors', 'dome', 12.5, 9.5, 'short'),
  st('sonar-array', 'Tune sonar array', 'sonar', 27.5, 3.5, 'long'),
  st('sonar-log', 'Log sonar contacts', 'sonar', 36.5, 9.5, 'short'),
  st('lab-samples', 'Analyze water samples', 'lab', 59.5, 3.5, 'long'),
  st('lab-jars', 'Label specimen jars', 'lab', 50.5, 10.5, 'short'),
  st('hydro-kelp', 'Prune kelp beds', 'hydro', 4.5, 19.5, 'short'),
  st('hydro-nutrients', 'Test nutrient mix', 'hydro', 12.5, 26.5, 'short'),
  st('commons-roster', 'Update duty roster', 'commons', 38.5, 27.5, 'short'),
  st('infirmary-kits', 'Restock first-aid kits', 'infirmary', 59.5, 19.5, 'short'),
  st('infirmary-sterilize', 'Sterilize instruments', 'infirmary', 51.5, 26.5, 'long'),
  st('generator-coolant', 'Bleed coolant lines', 'generator', 4.5, 42.5, 'long'),
  st('generator-breakers', 'Reset breaker panel', 'generator', 13.5, 35.5, 'short'),
  st('galley-rations', 'Restock ration lockers', 'galley', 27.5, 42.5, 'short'),
  st('galley-purifier', 'Repair water purifier', 'galley', 36.5, 35.5, 'short'),
  st('ballast-tanks', 'Equalize ballast tanks', 'ballast', 59.5, 42.5, 'long'),
  st('ballast-valves', 'Inspect pressure valves', 'ballast', 50.5, 35.5, 'short'),
];

const button: Vec2 = { x: 32, y: 22.5 };
const seats: Vec2[] = Array.from({ length: 10 }, (_, i) => {
  const angle = (2 * Math.PI * i) / 10 - Math.PI / 2;
  return { x: button.x + 3.5 * Math.cos(angle), y: button.y + 3.5 * Math.sin(angle) };
});

export const STATION_MAP: MapDef = {
  id: 'station',
  name: 'Placeholder Station',
  width: 64,
  height: 46,
  areas,
  stations,
  button: { areaId: 'commons', pos: button },
  seats,
};

/**
 * Headless simulator: runs games with scripted bots in every seat and prints stats.
 *
 *   npm run sim                          # 20 games
 *   npm run sim -- --games 100 --seed 7  # 100 games, seeds 7..106
 *   npm run sim -- --games 1 --log       # watch one game as a text log
 */
import { parseArgs } from 'node:util';
import { NavGrid, STATION_MAP } from '../engine';
import { describeResult, formatEvent } from './format';
import { runScriptedGame, type GameSummary } from './runGame';
import { checkInvariants } from './validate';

const { values } = parseArgs({
  options: {
    games: { type: 'string', default: '20' },
    seed: { type: 'string', default: '1' },
    players: { type: 'string', default: '9' },
    log: { type: 'boolean', default: false },
    tasks: { type: 'boolean', default: false },
  },
});

const games = Number(values.games);
const firstSeed = Number(values.seed);
const players = Number(values.players);
if (!Number.isInteger(games) || games < 1) throw new Error('--games must be a positive whole number');

const nav = new NavGrid(STATION_MAP);
const started = performance.now();
const summaries: GameSummary[] = [];
const problems: string[] = [];
for (let i = 0; i < games; i++) {
  const s = runScriptedGame({ seed: firstSeed + i, players, nav });
  summaries.push(s);
  for (const p of checkInvariants(s.game)) problems.push(`seed ${s.seed}: ${p}`);
}
const elapsed = (performance.now() - started) / 1000;

if (values.log) {
  const g = summaries[0].game;
  console.log(`\n=== Game log, seed ${g.seed} ===`);
  for (const e of g.events) {
    const line = formatEvent(e, g, { tasks: values.tasks });
    if (line) console.log(line);
  }
  console.log('');
}

const count = (pred: (s: GameSummary) => boolean) => summaries.filter(pred).length;
const avg = (f: (s: GameSummary) => number) => summaries.reduce((a, s) => a + f(s), 0) / summaries.length;
const pct = (n: number) => `${Math.round((100 * n) / games)}%`.padStart(4);
const mmss = (sec: number) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;

const byTasks = count((s) => s.result.reason === 'tasks');
const byEject = count((s) => s.result.reason === 'saboteurs_ejected');
const byParity = count((s) => s.result.reason === 'parity');
const timeouts = count((s) => s.result.reason === 'timeout');

console.log(`Ran ${games} game(s), seeds ${firstSeed}..${firstSeed + games - 1}, ${players} players, in ${elapsed.toFixed(1)}s`);
console.log(`  Crew wins      ${String(byTasks + byEject).padStart(4)} ${pct(byTasks + byEject)}   (tasks ${byTasks}, ejected all saboteurs ${byEject})`);
console.log(`  Saboteur wins  ${String(byParity).padStart(4)} ${pct(byParity)}`);
console.log(`  Timeouts       ${String(timeouts).padStart(4)} ${pct(timeouts)}`);
console.log(`  Average game: ${mmss(avg((s) => s.durationSec))} of game time, ${avg((s) => s.meetings).toFixed(1)} meetings, ${avg((s) => s.kills).toFixed(1)} kills, ${avg((s) => s.ejections).toFixed(1)} ejections`);
if (games === 1) console.log(`  Result: ${describeResult(summaries[0].result)}`);
console.log(`  Invariant problems: ${problems.length}`);
for (const p of problems.slice(0, 20)) console.log(`    - ${p}`);
if (problems.length > 0) process.exitCode = 1;

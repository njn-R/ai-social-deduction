/**
 * Compare every AI game saved in runs/ (by model, and by tier).
 *
 *   npm run ai:stats
 *   npm run ai:stats -- --dir runs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { comparisonLines } from './compare';
import type { GameMetrics } from './metrics';

const { values } = parseArgs({ options: { dir: { type: 'string', default: 'runs' } } });
const files = readdirSync(values.dir).filter((f) => /^\d{8}-\d{6}-seed\d+\.json$/.test(f));
const all = files.map((f) => (JSON.parse(readFileSync(join(values.dir, f), 'utf8')) as { metrics: GameMetrics }).metrics).filter((m) => m.model !== 'fake');
if (all.length === 0) {
  console.log(`No real AI games saved in ${values.dir}/ yet. Play one with: npm run ai`);
} else {
  console.log(`${all.length} saved game(s) in ${values.dir}/\n`);
  for (const line of comparisonLines(all)) console.log(line);
}

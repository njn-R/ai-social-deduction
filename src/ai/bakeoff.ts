/**
 * Model bake-off: play the same seeds with several local models and compare them.
 * Model ids come from the command line, so nothing about your setup lands in the repo.
 *
 *   npm run bakeoff -- --models <id1>,<id2> --seeds 1,2,3
 *   npm run bakeoff -- --current --seeds 1,2       # just the model already loaded
 *
 * Between models it runs `lms unload --all` and `lms load <id>` (skip with --no-load).
 * Results go to runs/ (not committed).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInvariants } from '../sim/validate';
import { LmStudioProvider } from './llm/lmstudio';
import { comparisonLines } from './compare';
import { computeMetrics, mmss, type GameMetrics } from './metrics';
import { saveRun } from './output';
import { runAiGame } from './runAiGame';

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    current: { type: 'boolean', default: false },
    seeds: { type: 'string', default: '1,2' },
    concurrency: { type: 'string', default: '4' },
    // LM Studio may split the context across its parallel slots, so leave room per slot.
    context: { type: 'string', default: '16384' },
    'no-load': { type: 'boolean', default: false },
    url: { type: 'string' },
    out: { type: 'string', default: 'runs' },
  },
});

const seeds = values.seeds.split(',').map(Number);
let models = (values.models ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (values.current) models = [await new LmStudioProvider({ baseUrl: values.url }).resolveModel()];
if (models.length === 0) throw new Error('Pass --models id1,id2 or --current');
const load = !values['no-load'] && !values.current;

function lms(args: string[]): void {
  const r = spawnSync('lms', args, { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`lms ${args.join(' ')} failed (exit ${r.status})`);
}

const all: GameMetrics[] = [];
for (const model of models) {
  if (load) {
    console.log(`\nLoading ${model}...`);
    lms(['unload', '--all']);
    lms(['load', model, '-c', values.context, '--gpu', 'max', '-y']);
  }
  for (const seed of seeds) {
    const report = await runAiGame({ seed, model, provider: new LmStudioProvider({ model, baseUrl: values.url }), concurrency: Number(values.concurrency) });
    const m = computeMetrics(report, seed);
    all.push(m);
    saveRun(values.out, report, m);
    const bad = checkInvariants(report.game).length;
    console.log(
      `  ${model} seed ${seed}: ${m.winner} (${m.reason}), ${mmss(m.wallSec)} wall, ${m.llmCalls} calls, avg ${(m.avgLatencyMs / 1000).toFixed(1)}s, ` +
        `${m.errors} errors, ${m.blockedLeaks} leaks blocked${bad ? `, ${bad} INVARIANT PROBLEMS` : ''}`,
    );
  }
}

console.log('');
for (const line of comparisonLines(all)) console.log(line);

mkdirSync(values.out, { recursive: true });
const file = join(values.out, `bakeoff-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}.json`);
writeFileSync(file, JSON.stringify(all, null, 2));
console.log(`\nRaw results: ${file}`);

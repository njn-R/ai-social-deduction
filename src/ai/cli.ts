/**
 * Play AI-only games and watch them as a text log.
 *
 *   npm run ai                         # one game on the model LM Studio has loaded
 *   npm run ai -- --thoughts           # also print each AI's private thoughts as they happen
 *   npm run ai -- --seed 3 --games 2   # seeds 3 and 4
 *   npm run ai -- --model <id>         # a specific LM Studio model (or set it in ai.local.json)
 *   npm run ai -- --fake               # no model at all: canned replies, for a quick dry run
 *   npm run ai -- --realtime           # run on the wall clock, like live play
 *
 * Each game writes a reveal (.md) and raw data (.json) to runs/ (not committed).
 */
import { parseArgs } from 'node:util';
import { formatEvent } from '../sim/format';
import { checkInvariants } from '../sim/validate';
import type { JournalEntry } from './journal';
import { FakeProvider } from './llm/fake';
import { LmStudioProvider } from './llm/lmstudio';
import { loadLocalConfig } from './localConfig';
import { computeMetrics, summaryLines } from './metrics';
import { saveRun } from './output';
import { runAiGame } from './runAiGame';
import { describeResult } from '../sim/format';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    games: { type: 'string', default: '1' },
    model: { type: 'string' },
    url: { type: 'string' },
    fake: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    realtime: { type: 'boolean', default: false },
    thoughts: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    out: { type: 'string', default: 'runs' },
  },
});

const local = loadLocalConfig();
const firstSeed = Number(values.seed);
for (let i = 0; i < Number(values.games); i++) {
  const seed = firstSeed + i;
  const lm = values.fake ? null : new LmStudioProvider({ model: values.model ?? local.model, baseUrl: values.url ?? local.url });
  const provider = lm ?? new FakeProvider({ seed });
  const model = lm ? await lm.resolveModel() : 'fake';
  console.log(`\n=== AI game, seed ${seed}, model ${model} ===`);

  // Print each thought right after the line or vote it belongs to.
  const pending = new Map<string, JournalEntry>();
  const thought = (e: JournalEntry | undefined) => e?.thoughts && console.log(`          ~ thinks: ${e.thoughts}`);
  const report = await runAiGame({
    seed,
    provider,
    model,
    concurrency: Number(values.concurrency),
    mode: values.realtime ? 'realtime' : 'virtual',
    onEvent: (e, game) => {
      if (values.quiet) return;
      const line = formatEvent(e, game);
      if (line) console.log(line);
      if (!values.thoughts) return;
      if (e.type === 'chat') thought(pending.get(`turn:${e.playerId}`));
      if (e.type === 'vote_cast') thought(pending.get(`vote:${e.voterId}`));
    },
    onJournal: (j) => {
      if (j.kind === 'error') console.log(`   ! ${j.playerId}: ${j.thoughts}`);
      if (values.quiet || !values.thoughts) return;
      if (j.kind === 'turn' || j.kind === 'vote') pending.set(`${j.kind}:${j.playerId}`, j);
      if (j.kind === 'plan') console.log(`          ~ ${j.playerId} plans (${j.said}): ${j.thoughts}`);
      if (j.kind === 'blocked') console.log(`          ~ ${j.playerId}'s line was blocked (${j.detail}): ${j.said}`);
    },
  });

  const metrics = computeMetrics(report, seed);
  const file = saveRun(values.out, report, metrics);
  console.log(`\nResult: ${describeResult(report.game.result!)}`);
  for (const line of summaryLines(metrics)) console.log(`  ${line}`);
  const problems = checkInvariants(report.game);
  console.log(`  Invariant problems: ${problems.length}${problems.length ? ` (${problems.join('; ')})` : ''}`);
  console.log(`  Reveal: ${file}`);
}

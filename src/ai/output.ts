import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameMetrics } from './metrics';
import { buildReveal } from './reveal';
import type { AiGameReport } from './runAiGame';

/** Write the reveal (.md) and raw data (.json) for one game. Returns the .md path. */
export function saveRun(dir: string, report: AiGameReport, metrics: GameMetrics): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const base = join(dir, `${stamp}-seed${metrics.seed}`);
  writeFileSync(`${base}.md`, buildReveal(report, metrics));
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ metrics, events: report.game.events, journal: report.journal.entries, cast: report.personas.map((p) => ({ id: p.id, tier: p.tier })) }, null, 2),
  );
  return `${base}.md`;
}

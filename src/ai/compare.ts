import type { GameMetrics } from './metrics';
import type { Tier } from './tiers';

const pct = (n: number, d: number) => (d === 0 ? '  -' : `${Math.round((100 * n) / d)}%`).padStart(4);
const sum = (ms: GameMetrics[], f: (m: GameMetrics) => number) => ms.reduce((a, m) => a + f(m), 0);

/** A per-model table and a per-tier breakdown over a set of finished AI games. */
export function comparisonLines(all: GameMetrics[]): string[] {
  const models = [...new Set(all.map((m) => m.model))];
  const out = ['Model comparison', `${'model'.padEnd(44)} games crew-win  avg-call   p90 errors leaks crew-vote-acc skip-rate lines/meeting`];
  for (const model of models) {
    const ms = all.filter((m) => m.model === model);
    const votes = sum(ms, (m) => m.crewVotes.total);
    const aimed = sum(ms, (m) => m.crewVotes.onSaboteurs + m.crewVotes.onCrew);
    out.push(
      [
        model.padEnd(44),
        String(ms.length).padStart(5),
        pct(ms.filter((m) => m.winner === 'crew').length, ms.length).padStart(8),
        `${(sum(ms, (m) => m.avgLatencyMs) / ms.length / 1000).toFixed(1)}s`.padStart(9),
        `${(Math.max(...ms.map((m) => m.p90LatencyMs)) / 1000).toFixed(1)}s`.padStart(5),
        String(sum(ms, (m) => m.errors)).padStart(6),
        String(sum(ms, (m) => m.blockedLeaks)).padStart(5),
        pct(sum(ms, (m) => m.crewVotes.onSaboteurs), aimed).padStart(13),
        pct(sum(ms, (m) => m.crewVotes.skips), votes).padStart(9),
        (sum(ms, (m) => m.lines) / Math.max(1, sum(ms, (m) => m.meetings))).toFixed(1).padStart(13),
      ].join(' '),
    );
  }
  // Split by role: with 2 saboteur seats a game, a tier's overall win rate mostly says
  // which tier happened to draw saboteur.
  out.push('', 'By tier (games won as crew; games won as saboteur; crew votes that hit a saboteur)');
  for (const tier of ['rookie', 'average', 'sharp', 'mastermind'] as Tier[]) {
    const t = (f: (s: GameMetrics['tiers'][Tier]) => number) => sum(all, (m) => f(m.tiers[tier]));
    const crew = t((s) => s.crew);
    const sab = t((s) => s.saboteurs);
    // A whole side wins together, so this works for saved games from before the split too.
    const crewWon = sum(all, (m) => (m.winner === 'crew' ? m.tiers[tier].crew : 0));
    const sabWon = sum(all, (m) => (m.winner === 'saboteurs' ? m.tiers[tier].saboteurs : 0));
    out.push(
      `  ${tier.padEnd(10)} as crew ${pct(crewWon, crew)} of ${crew}, ` +
        `as saboteur ${pct(sabWon, sab)} of ${sab}, ` +
        `crew votes on saboteurs ${pct(t((s) => s.crewVotesOnSaboteurs), t((s) => s.crewVotes))} of ${t((s) => s.crewVotes)}`,
    );
  }
  return out;
}

import { ticksToSec, type GameResult, type Role } from '../engine';
import type { AiGameReport } from './runAiGame';
import type { Tier } from './tiers';

export interface TierStats {
  players: number;
  crew: number;
  saboteurs: number;
  survived: number;
  /** Ended on the winning side. */
  won: number;
  wonAsCrew: number;
  wonAsSaboteur: number;
  crewVotes: number;
  crewVotesOnSaboteurs: number;
}

export interface GameMetrics {
  seed: number;
  model: string;
  winner: GameResult['winner'];
  reason: GameResult['reason'];
  gameSec: number;
  wallSec: number;
  kills: number;
  meetings: number;
  ejectedSaboteurs: number;
  ejectedCrew: number;
  crewVotes: { total: number; onSaboteurs: number; onCrew: number; skips: number };
  lines: number;
  quietTurns: number;
  blockedLeaks: number;
  errors: number;
  llmCalls: number;
  avgLatencyMs: number;
  p90LatencyMs: number;
  completionTokens: number;
  avgPromptTokens: number;
  maxPromptTokens: number;
  tiers: Record<Tier, TierStats>;
}

const emptyTier = (): TierStats => ({
  players: 0,
  crew: 0,
  saboteurs: 0,
  survived: 0,
  won: 0,
  wonAsCrew: 0,
  wonAsSaboteur: 0,
  crewVotes: 0,
  crewVotesOnSaboteurs: 0,
});

export function computeMetrics(r: AiGameReport, seed: number): GameMetrics {
  const g = r.game;
  const result = g.result!;
  const role = (id: string): Role => g.player(id).role;
  const crewVotes = { total: 0, onSaboteurs: 0, onCrew: 0, skips: 0 };
  const perVoter = new Map<string, { total: number; right: number }>();
  let ejectedSaboteurs = 0;
  let ejectedCrew = 0;

  for (const e of g.events) {
    if (e.type !== 'meeting_result') continue;
    if (e.result.ejectedId) role(e.result.ejectedId) === 'saboteur' ? ejectedSaboteurs++ : ejectedCrew++;
    for (const [voter, target] of Object.entries(e.result.votes)) {
      if (role(voter) !== 'crew') continue;
      crewVotes.total++;
      const v = perVoter.get(voter) ?? { total: 0, right: 0 };
      if (target === 'skip') crewVotes.skips++;
      else if (role(target) === 'saboteur') {
        crewVotes.onSaboteurs++;
        v.right++;
      } else crewVotes.onCrew++;
      if (target !== 'skip') v.total++;
      perVoter.set(voter, v);
    }
  }

  const tiers: Record<Tier, TierStats> = { rookie: emptyTier(), average: emptyTier(), sharp: emptyTier(), mastermind: emptyTier() };
  for (const p of r.personas) {
    const t = tiers[p.tier];
    const player = g.player(p.id);
    t.players++;
    if (player.role === 'crew') t.crew++;
    else t.saboteurs++;
    if (player.alive) t.survived++;
    if (result.winner === (player.role === 'crew' ? 'crew' : 'saboteurs')) {
      t.won++;
      if (player.role === 'crew') t.wonAsCrew++;
      else t.wonAsSaboteur++;
    }
    const v = perVoter.get(p.id);
    if (v) {
      t.crewVotes += v.total;
      t.crewVotesOnSaboteurs += v.right;
    }
  }

  const lat = [...r.stats.latenciesMs].sort((a, b) => a - b);
  return {
    seed,
    model: r.model,
    winner: result.winner,
    reason: result.reason,
    gameSec: ticksToSec(g.tick),
    wallSec: r.wallMs / 1000,
    kills: g.events.filter((e) => e.type === 'kill').length,
    meetings: g.events.filter((e) => e.type === 'meeting_called').length,
    ejectedSaboteurs,
    ejectedCrew,
    crewVotes,
    lines: g.events.filter((e) => e.type === 'chat').length,
    quietTurns: r.journal.entries.filter((e) => e.kind === 'turn' && e.said === '(stays quiet)').length,
    blockedLeaks: r.journal.count('blocked'),
    errors: r.journal.count('error'),
    llmCalls: r.stats.calls,
    avgLatencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0,
    p90LatencyMs: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))] : 0,
    completionTokens: r.stats.completionTokens,
    avgPromptTokens: r.stats.calls ? Math.round(r.stats.promptTokens / r.stats.calls) : 0,
    maxPromptTokens: r.stats.maxPromptTokens,
    tiers,
  };
}

export function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;
}

/** A few lines summarising one game. */
export function summaryLines(m: GameMetrics): string[] {
  const cv = m.crewVotes;
  const tierLine = (Object.entries(m.tiers) as [Tier, TierStats][])
    .filter(([, t]) => t.players > 0)
    .map(([tier, t]) => `${tier} ${t.won}/${t.players}${t.saboteurs ? ` (${t.saboteurs} saboteur)` : ''}`)
    .join(', ');
  return [
    `Game time ${mmss(m.gameSec)}, wall time ${mmss(m.wallSec)}`,
    `LLM: ${m.llmCalls} calls, avg ${(m.avgLatencyMs / 1000).toFixed(1)}s, p90 ${(m.p90LatencyMs / 1000).toFixed(1)}s, prompts avg ${m.avgPromptTokens} / max ${m.maxPromptTokens} tokens, ${m.errors} errors, ${m.blockedLeaks} lines blocked for leaking a role`,
    `Meetings ${m.meetings}, lines spoken ${m.lines} (${m.quietTurns} chose to stay quiet), kills ${m.kills}, ejected ${m.ejectedSaboteurs} saboteur(s) and ${m.ejectedCrew} crew`,
    `Crew votes: ${cv.total} (${cv.onSaboteurs} on saboteurs, ${cv.onCrew} on crew, ${cv.skips} skips)`,
    `On the winning side, by tier: ${tierLine}`,
  ];
}

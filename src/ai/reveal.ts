import { formatClock, formatEvent, describeResult } from '../sim/format';
import type { JournalEntry } from './journal';
import { summaryLines, type GameMetrics } from './metrics';
import type { AiGameReport } from './runAiGame';

/**
 * The post-game reveal as Markdown: who was what, the full timeline, and every private
 * thought next to what was actually said.
 */
export function buildReveal(r: AiGameReport, m: GameMetrics): string {
  const g = r.game;
  const name = (id: string) => g.player(id).name;
  const out: string[] = [];
  out.push(`# Game ${m.seed}: ${describeResult(g.result!)}`, '', `Model: ${m.model}`, '');
  for (const line of summaryLines(m)) out.push(`- ${line}`);

  out.push('', '## Cast', '', '| Player | Tier | Role | Fate |', '|---|---|---|---|');
  for (const p of r.personas) {
    const s = g.player(p.id);
    const fate = s.alive ? 'survived' : s.ejected ? `ejected at ${formatClock(s.diedAtTick!)}` : `killed at ${formatClock(s.diedAtTick!)}`;
    out.push(`| ${p.name} (${p.archetype}) | ${p.tier} | ${s.role === 'saboteur' ? '**saboteur**' : 'crew'} | ${fate} |`);
  }

  // Timeline: events, with each line's private thought underneath.
  out.push('', '## Timeline', '');
  const unused = [...r.journal.entries];
  const take = (pred: (e: JournalEntry) => boolean): JournalEntry | undefined => {
    const i = unused.findIndex(pred);
    return i >= 0 ? unused.splice(i, 1)[0] : undefined;
  };
  for (const e of g.events) {
    for (const plan of unused.filter((j) => j.kind === 'plan' && j.tick <= e.tick)) {
      take((j) => j === plan);
      out.push(`- [${formatClock(plan.tick)}] _${name(plan.playerId)} plans (${plan.said}): ${plan.thoughts}_`);
    }
    const line = formatEvent(e, g);
    if (!line) continue;
    out.push(`- ${line.trim()}`);
    if (e.type === 'chat') {
      const j = take((x) => x.kind === 'turn' && x.playerId === e.playerId && x.tick === e.tick);
      if (j?.thoughts) out.push(`  - _thinks: ${j.thoughts}_`);
    }
    if (e.type === 'vote_cast') {
      const j = take((x) => x.kind === 'vote' && x.playerId === e.voterId && x.tick <= e.tick);
      if (j?.thoughts) out.push(`  - _thinks: ${j.thoughts}_`);
    }
  }

  out.push('', '## Every private moment, by player', '');
  for (const p of r.personas) {
    const entries = r.journal.entries.filter((j) => j.playerId === p.id);
    out.push(`### ${p.name} (${p.tier}, ${g.player(p.id).role})`, '');
    if (entries.length === 0) out.push('_No AI calls._', '');
    for (const j of entries) {
      const said = j.said ? ` → ${j.kind === 'turn' ? `"${j.said}"` : j.said}` : '';
      const extra = j.detail ? ` (${j.detail})` : '';
      out.push(`- [${formatClock(j.tick)}] **${j.kind}**${said}${extra}: ${j.thoughts || '(no thoughts)'}`);
      if (j.reasoning) out.push(`  - hidden reasoning: ${j.reasoning.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    out.push('');
  }
  return out.join('\n');
}

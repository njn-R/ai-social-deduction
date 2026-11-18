import { secToTicks, TICK_RATE, type ChatMessage, type Claim, type GameConfig, type NavGrid, type Observation, type PlayerId } from '../engine';
import type { MeetingRecord, Memory, Sighting } from './memory';
import { clock, span } from './text';
import type { TierProfile } from './tiers';

export interface NotesContext {
  obs: Observation;
  memory: Memory;
  tier: TierProfile;
  nav: NavGrid;
  config: GameConfig;
  name: (id: PlayerId) => string;
}

/**
 * The agent's private notes for its prompt. Code does the bookkeeping (who was where,
 * whose story clashes with what you saw) so even a small model can reason well.
 * Higher tiers get more of it.
 */
export function buildNotes(ctx: NotesContext): string {
  const sections = [
    movements(ctx),
    bodies(ctx),
    ctx.obs.self.role === 'saboteur' ? saboteurNotes(ctx) : [],
    sightings(ctx),
    meetingHistory(ctx),
    ctx.tier.notebook >= 2 ? claimsCheck(ctx) : [],
    ctx.tier.notebook >= 3 ? pressure(ctx) : [],
  ];
  const text = sections.filter((s) => s.length > 0).map((s) => s.join('\n')).join('\n\n');
  return text || '(nothing noteworthy yet)';
}

const areaName = (ctx: NotesContext, id: string | null) => (id ? ctx.nav.area(id).name : 'an unknown spot');

function movements(ctx: NotesContext): string[] {
  const start = ctx.memory.currentRoundStart;
  const steps = ctx.memory.trail.filter((s) => s.to >= start && s.to - s.from >= TICK_RATE);
  const keep = ctx.tier.notebook === 0 ? 3 : 8;
  if (steps.length === 0) return [];
  return ['Where you went this round:', ...steps.slice(-keep).map((s) => `- ${span(s.from, s.to)} ${areaName(ctx, s.areaId)}`)];
}

function bodies(ctx: NotesContext): string[] {
  const mine = new Set(ctx.memory.kills.map((k) => k.victimId));
  const lines = ctx.memory.bodies
    .filter((b) => !mine.has(b.victimId))
    .map((b) => {
      const where = `in ${areaName(ctx, b.areaId)} at ${clock(b.tick)}`;
      if (b.killer) return `- You SAW ${ctx.name(b.killer)} kill ${ctx.name(b.victimId)} ${where}!`;
      const near = b.nearby.length > 0 ? b.nearby.map(ctx.name).join(', ') : 'nobody';
      return `- You found ${ctx.name(b.victimId)}'s body ${where}. Near it: ${near}.`;
    });
  return lines.length > 0 ? ['Bodies:', ...lines] : [];
}

function sightings(ctx: NotesContext): string[] {
  const seen = ctx.memory.recall(ctx.obs.tick, TICK_RATE);
  if (seen.length === 0) return ['People you saw: nobody you remember.'];
  const header = ctx.tier.notebook === 0 ? "People you saw (you're not totally sure of these):" : 'People you saw (most recent first):';
  return [header, ...seen.map((s) => `- ${describeSighting(ctx, s)}`)];
}

function describeSighting(ctx: NotesContext, s: Sighting): string {
  const work = s.working ? `, working at "${ctx.nav.station(s.working).name}"` : '';
  return `${span(s.from, s.to)} ${ctx.name(s.playerId)} in ${areaName(ctx, s.areaId)}${work}`;
}

function saboteurNotes(ctx: NotesContext): string[] {
  const { memory, obs, config } = ctx;
  const team = new Set(obs.saboteurTeam);
  const lines: string[] = [];
  for (const k of memory.kills) lines.push(`- You killed ${ctx.name(k.victimId)} in ${areaName(ctx, k.areaId)} at ${clock(k.tick)}.`);

  // Crew who came within their vision range of you could have seen you.
  const start = memory.currentRoundStart;
  const witnesses = memory.sightings.filter((s) => s.to >= start && !team.has(s.playerId) && s.closest <= config.crewVision);
  if (witnesses.length > 0) {
    lines.push('Crew who were close enough to see you this round:');
    for (const s of witnesses.slice(-8)) lines.push(`- ${span(s.from, s.to)} ${ctx.name(s.playerId)} in ${areaName(ctx, s.areaId)}`);
  } else {
    lines.push('No crew got close enough to see you this round.');
  }

  if (ctx.tier.notebook >= 3) {
    const story = safeStory(ctx, witnesses);
    if (story) lines.push(story);
  }
  return lines.length > 0 ? ['Your secret record:', ...lines] : [];
}

/** A place you could claim to have been that nobody you saw could disprove. */
function safeStory(ctx: NotesContext, witnesses: Sighting[]): string | null {
  const crewAreas = new Set(witnesses.map((w) => w.areaId));
  const killAreas = new Set(ctx.memory.kills.map((k) => k.areaId));
  for (const t of ctx.obs.self.tasks) {
    const st = ctx.nav.station(t.stationId);
    if (crewAreas.has(st.areaId) || killAreas.has(st.areaId)) continue;
    return `Safe story: say you were in ${areaName(ctx, st.areaId)} doing "${st.name}". Nobody you saw was there to disprove it.`;
  }
  return null;
}

function meetingHistory(ctx: NotesContext): string[] {
  const current = ctx.obs.meeting?.index;
  const past = ctx.memory.meetings.filter((m) => m.index !== current && m.result);
  if (past.length === 0) return [];
  if (ctx.tier.notebook === 0) {
    const last = past.at(-1)!;
    return [`Last meeting: ${resultText(ctx, last)}`];
  }
  const lines = ['Earlier meetings:'];
  for (const m of past) {
    const opener =
      m.reason === 'body' && m.victimId
        ? `${ctx.name(m.calledBy)} reported ${ctx.name(m.victimId)}'s body in ${areaName(ctx, m.bodyAreaId)}`
        : `${ctx.name(m.calledBy)} pressed the emergency button`;
    const votes = Object.entries(m.result!.votes)
      .map(([voter, target]) => `${ctx.name(voter)}->${target === 'skip' ? 'skip' : ctx.name(target)}`)
      .join(', ');
    lines.push(`- Meeting ${m.index + 1}: ${opener}. Votes: ${votes || 'none'}. ${resultText(ctx, m)}`);
  }
  return lines;
}

function resultText(ctx: NotesContext, m: MeetingRecord): string {
  const r = m.result!;
  if (!r.ejectedId) return `Nobody was ejected (${r.tie ? 'tie' : 'skipped'}).`;
  const role = r.revealedRole ? ` and was ${r.revealedRole === 'saboteur' ? 'a SABOTEUR' : 'crew'}` : '';
  return `${ctx.name(r.ejectedId)} was ejected${role}.`;
}

/** Compare every claim made in meetings with what this agent actually saw. */
function claimsCheck(ctx: NotesContext): string[] {
  const { memory, obs } = ctx;
  const me = obs.self.id;
  const lines: string[] = [];
  for (const rec of [...memory.meetings].reverse()) {
    const roundStart = memory.roundStarts[rec.round - 1] ?? 0;
    for (const msg of chatOf(ctx, rec)) {
      if (msg.playerId === me || !msg.claims) continue;
      for (const c of msg.claims) {
        const [from, to] = claimWindow(c, roundStart, rec.startTick);
        const self = checkSelf(ctx, msg.playerId, c, from, to);
        if (self) lines.push(self);
        if (c.saw.includes(me)) {
          const wasThere = memory.trail.some((s) => s.areaId === c.areaId && s.to >= from && s.from <= to);
          if (!wasThere) lines.push(`- ${ctx.name(msg.playerId)} says they saw YOU in ${areaName(ctx, c.areaId)}. FALSE: you weren't there.`);
        }
        for (const other of c.saw) {
          if (other === me) continue;
          const conflict = conflictFor(ctx, other, c, from, to);
          if (conflict) lines.push(`- ${ctx.name(msg.playerId)} says they saw ${ctx.name(other)} in ${areaName(ctx, c.areaId)}. ${conflict}`);
        }
      }
    }
  }
  return lines.length > 0 ? ['Claims checked against what you saw:', ...lines.slice(0, 10)] : [];
}

/** A meeting's chat: live from the observation if it's the current one, else as remembered. */
function chatOf(ctx: NotesContext, rec: MeetingRecord): ChatMessage[] {
  const live = ctx.obs.meeting;
  return live && live.index === rec.index ? live.chat : rec.chat;
}

/**
 * The stretch of time a claim is about. With a time: a few seconds either side.
 * Without one: the half-minute before the meeting, which is what people usually mean.
 */
function claimWindow(c: Claim, roundStart: number, meetingStart: number): [number, number] {
  if (c.atTick !== null) return [c.atTick - secToTicks(8), c.atTick + secToTicks(8)];
  return [Math.max(roundStart, meetingStart - secToTicks(30)), meetingStart];
}

function checkSelf(ctx: NotesContext, who: PlayerId, c: Claim, from: number, to: number): string | null {
  const when = c.atTick !== null ? ` at ${clock(c.atTick)}` : '';
  const head = `- ${ctx.name(who)} says they were in ${areaName(ctx, c.areaId)}${when}.`;
  const mine = ctx.memory.sightings.filter((s) => s.playerId === who && s.to >= from && s.from <= to);
  if (mine.length === 0) return null;
  if (mine.some((s) => s.areaId === c.areaId)) return `${head} Matches what you saw.`;
  const s = mine.at(-1)!;
  // Only a claim pinned to a time can truly clash; people move around.
  const verdict = c.atTick !== null ? 'CONFLICT' : "Doesn't match";
  return `${head} ${verdict}: you saw them in ${areaName(ctx, s.areaId)} at ${span(s.from, s.to)}.`;
}

function conflictFor(ctx: NotesContext, who: PlayerId, c: Claim, from: number, to: number): string | null {
  const mine = ctx.memory.sightings.filter((s) => s.playerId === who && s.to >= from && s.from <= to);
  if (mine.length === 0 || mine.some((s) => s.areaId === c.areaId)) return null;
  const s = mine.at(-1)!;
  const verdict = c.atTick !== null ? 'CONFLICT' : "Doesn't match";
  return `${verdict}: you saw ${ctx.name(who)} in ${areaName(ctx, s.areaId)} at ${span(s.from, s.to)}.`;
}

/** Who is pushing whom, across all meetings. */
function pressure(ctx: NotesContext): string[] {
  const accusations = new Map<string, Map<string, number>>();
  const votesAgainst = new Map<string, number>();
  for (const m of ctx.memory.meetings) {
    for (const msg of chatOf(ctx, m)) {
      if (!msg.accuse) continue;
      const row = accusations.get(msg.playerId) ?? new Map<string, number>();
      row.set(msg.accuse, (row.get(msg.accuse) ?? 0) + 1);
      accusations.set(msg.playerId, row);
    }
    for (const target of Object.values(m.result?.votes ?? {})) {
      if (target !== 'skip') votesAgainst.set(target, (votesAgainst.get(target) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  for (const [who, row] of accusations) {
    const list = [...row].map(([t, n]) => `${ctx.name(t)}${n > 1 ? ` x${n}` : ''}`).join(', ');
    lines.push(`- ${ctx.name(who)} has accused: ${list}`);
  }
  if (votesAgainst.size > 0) {
    lines.push(`- Votes received so far: ${[...votesAgainst].map(([t, n]) => `${ctx.name(t)} ${n}`).join(', ')}`);
  }
  return lines.length > 0 ? ['Who is pushing whom:', ...lines] : [];
}

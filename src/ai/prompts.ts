import type { GameConfig, NavGrid, Observation, PlayerId, Rect } from '../engine';
import type { Memory } from './memory';
import { buildNotes } from './notebook';
import { describeTraits, type Persona } from './personas';
import { clock } from './text';
import type { TierProfile } from './tiers';

export interface PromptParts {
  obs: Observation;
  memory: Memory;
  persona: Persona;
  tier: TierProfile;
  nav: NavGrid;
  config: GameConfig;
  name: (id: PlayerId) => string;
}

/** Static rules shared by every call in a game (stays cached on the model server). */
export function systemPrompt(nav: NavGrid, config: GameConfig, playerCount: number): string {
  return `You are one player in a social-deduction game on an underwater research station. There are ${playerCount} players. ${config.saboteurs} of them are secret saboteurs who know each other; everyone else is crew.

Rules:
- Crew win by finishing all their tasks or by voting out every saboteur.
- Saboteurs win when they equal the crew in number. They kill crew when nobody is watching and pretend to do tasks. Nobody can tell a real task from a fake one by watching.
- When someone reports a body or presses the emergency button, everyone meets: first discussion, then a vote. The player with the most votes is ejected. A tie, or "skip" winning, ejects nobody.${config.confirmEjects ? " An ejected player's role is revealed." : ''}
- Everyone can only see a short distance, and walls block sight.

Map:
${mapSummary(nav)}

How to answer:
- Reply with JSON only, matching the schema.
- "thoughts" is private. Nobody else ever sees it.
- "say" is spoken out loud to everyone: in character, at most 2 short sentences, no narration, no quotation marks, no emojis.
- A saboteur never admits it, even in a joke.
- Use player names and room names exactly as given.`;
}

export function mapSummary(nav: NavGrid): string {
  const rooms = nav.rooms();
  const touches = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
  const links = new Map<string, Set<string>>(rooms.map((r) => [r.id, new Set<string>()]));
  for (const hall of nav.map.areas.filter((a) => a.kind === 'hall')) {
    const ends = rooms.filter((r) => touches(hall.rect, r.rect));
    for (const a of ends) for (const b of ends) if (a.id !== b.id) links.get(a.id)!.add(b.id);
  }
  return rooms
    .map((r) => {
      const extra = r.id === nav.map.button.areaId ? ' (meeting table and emergency button)' : '';
      return `- ${r.name}${extra}: corridors to ${[...links.get(r.id)!].map((id) => nav.area(id).name).join(', ')}`;
    })
    .join('\n');
}

// ── Shared situation (identical for every agent at a given moment) ─────────

function roster(p: PromptParts): string {
  const { obs } = p;
  const ejected = new Map<PlayerId, string>();
  for (const m of p.memory.meetings) {
    const r = m.result;
    if (r?.ejectedId) ejected.set(r.ejectedId, r.revealedRole ? `ejected, was ${r.revealedRole}` : 'ejected');
  }
  const victim = obs.meeting?.victimId ?? null;
  const alive = obs.roster.filter((r) => !r.knownDead).map((r) => r.name);
  const dead = obs.roster
    .filter((r) => r.knownDead)
    .map((r) => `${r.name} (${ejected.get(r.id) ?? (r.id === victim ? 'body found just now' : 'killed')})`);
  return `Alive: ${alive.join(', ')}.\nDead: ${dead.length > 0 ? dead.join(', ') : 'nobody yet'}.`;
}

function meetingSituation(p: PromptParts): string {
  const m = p.obs.meeting!;
  const area = (id: string | null) => (id ? p.nav.area(id).name : 'an unknown spot');
  const opener =
    m.reason === 'body' && m.victimId
      ? `${p.name(m.calledBy)} reported ${p.name(m.victimId)}'s body in ${area(m.bodyAreaId)}.`
      : `${p.name(m.calledBy)} pressed the emergency button.`;
  const chat = m.chat.slice(-25).map((c) => `[${clock(c.tick)}] ${p.name(c.playerId)}: ${c.text}`);
  return [
    `== MEETING ${m.index + 1} (game time ${clock(p.obs.tick)}) ==`,
    opener,
    roster(p),
    m.stage === 'discussion' ? `Discussion time left: ${Math.round(m.secLeft)}s.` : `Voting is open (${Math.round(m.secLeft)}s left).`,
    'Chat so far:',
    chat.length > 0 ? chat.join('\n') : '(nobody has spoken yet)',
  ].join('\n');
}

// ── Private part ───────────────────────────────────────────────────────────

function selfBlock(p: PromptParts): string {
  const { persona: me, obs } = p;
  const traits = describeTraits(me.traits);
  const lines = [
    '== YOU ==',
    `You are ${me.name}, a ${me.archetype}.${traits ? ` Personality: ${traits}.` : ''}`,
    `How you talk: ${me.voice} ${me.quirks.join('. ')}.`,
    `Example of your voice: ${me.sampleLines.join(' / ')}`,
    p.tier.skill,
  ];
  if (obs.self.role === 'saboteur') {
    const team = obs.saboteurTeam.map((id) => {
      const gone = obs.roster.find((r) => r.id === id)?.knownDead;
      return `${p.name(id)}${gone ? ' (gone)' : ''}`;
    });
    lines.push(
      `Your secret role: SABOTEUR, with ${team.join(' and ') || 'nobody else'}. ${me.asSaboteur}`,
      'Deflect suspicion and keep your story consistent with what others may have seen. Never accuse or vote out your partner unless it saves you.',
    );
  } else {
    lines.push(`Your secret role: CREW. ${me.asCrew} You don't know who the saboteurs are.`);
  }
  return lines.join('\n');
}

function notesBlock(p: PromptParts): string {
  return `== YOUR PRIVATE NOTES ==\n${buildNotes(p)}`;
}

// ── The three kinds of call ────────────────────────────────────────────────

export function turnPrompt(p: PromptParts, cue: string): string {
  const mine = p.obs.meeting!.chat.filter((c) => c.playerId === p.obs.self.id).map((c) => `- ${c.text}`);
  const repeat = mine.length > 0 ? `You already said in this meeting:\n${mine.join('\n')}\nDon't repeat yourself: say something new, answer someone, or stay quiet.` : '';
  return [
    meetingSituation(p),
    selfBlock(p),
    notesBlock(p),
    '== YOUR TURN ==',
    cue,
    repeat,
    `Think in "thoughts" (at most ${p.tier.thoughtWords} words), then speak in "say".`,
    'Set "accuse" to a name only if "say" accuses that person, else "nobody".',
    'In "claims", list where "say" says you were (time as m:ss if you give one, else "") and who you saw there. Leave it empty if "say" makes no such claim.',
    'If you have nothing useful to add, use intent "stay_quiet" and an empty "say".',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function votePrompt(p: PromptParts): string {
  const sab = p.obs.self.role === 'saboteur';
  return [
    meetingSituation(p),
    selfBlock(p),
    notesBlock(p),
    '== VOTE NOW ==',
    sab
      ? 'Vote to eject a crew member the group already suspects, or "skip" if a vote would expose you. Never vote for your partner.'
      : 'Vote for the player you believe is a saboteur, or "skip" if you are not sure. A wrong ejection helps the saboteurs.',
    `Think in "thoughts" (at most ${p.tier.thoughtWords} words), then give your "vote".`,
  ].join('\n\n');
}

export function planPrompt(p: PromptParts): string {
  const sab = p.obs.self.role === 'saboteur';
  const lastMeeting = p.memory.meetings.at(-1)?.result;
  const outcome = lastMeeting
    ? lastMeeting.ejectedId
      ? `Last meeting ejected ${p.name(lastMeeting.ejectedId)}${lastMeeting.revealedRole ? ` (${lastMeeting.revealedRole})` : ''}.`
      : 'Last meeting ejected nobody.'
    : 'This is the first round.';
  return [
    `== ROUND ${p.obs.round} STARTS (game time ${clock(p.obs.tick)}) ==`,
    'Everyone is back at the meeting table in Commons.',
    roster(p),
    `${outcome} Crew task bar: ${Math.round(p.obs.taskProgress * 100)}%.`,
    selfBlock(p),
    notesBlock(p),
    '== PLAN THIS ROUND ==',
    sab
      ? 'Pick a "target" to hunt first ("anyone" if you have no preference; you will still strike others caught alone), a "style" (patient: wait until the coast has been clear a few seconds; normal; aggressive: strike the moment someone is alone), and a "buddy" to be seen with for an alibi, or "nobody". The crew wins if they finish their tasks, so you cannot wait forever.'
      : 'Pick a "buddy" to stay near (someone you trust) or "nobody", and someone to "avoid" (someone you suspect) or "nobody".',
    `Think in "thoughts" first (at most ${p.tier.thoughtWords} words).`,
  ].join('\n\n');
}

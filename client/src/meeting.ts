import type { PlayerId } from '../../src/engine';
import type { ClientMessage } from '../../src/shared/protocol';
import { hex } from './colors';
import { el, show } from './dom';
import { colorOf, nameOf, type ClientState } from './state';
import type { Spoken } from './voice';

/** Typing speed for lines that aren't read aloud, in characters per second. */
const TYPE_CPS = 45;
/** Give up waiting for a voice after this long and just type the line out. */
const VOICE_WAIT_MS = 8000;

/** A chat line being revealed word by word. */
interface Reveal {
  span: HTMLElement;
  full: string;
  /** Revealed in step with the voice (else typed out at TYPE_CPS). */
  voiced: boolean;
  created: number;
  /** Spoken sentences and when they play. */
  segments: { words: string[]; start: number; dur: number }[];
  spokenDone: boolean;
  /** When the voice didn't come through, type it out from this time instead. */
  typeFrom: number | null;
  complete: boolean;
}

/** The meeting screen: who's here, the conversation, and the vote. */
export class MeetingView {
  readonly root = el('div', { class: 'overlay meeting hidden' });
  private readonly title = el('h2', {});
  private readonly timer = el('div', { class: 'timer' });
  private readonly controls = el('div', { class: 'meeting-controls' });
  private readonly players = el('div', { class: 'players' });
  private readonly log = el('div', { class: 'chat-log' });
  private readonly typing = el('div', { class: 'typing' });
  private readonly input = el('input', { type: 'text', maxlength: '240', placeholder: 'Say something... (Enter to send)' });
  private readonly result = el('div', { class: 'result hidden' });
  private shownIndex = -1;
  private shownLines = 0;
  private lastTypingPing = 0;
  private readonly reveals = new Map<string, Reveal>();
  private readonly cards = new Map<PlayerId, { root: HTMLElement; voted: HTMLElement; dead: HTMLElement; vote: HTMLButtonElement }>();
  private readonly skip = el('button', { class: 'vote skip', type: 'button', onclick: () => this.vote('skip') }, 'Skip vote');
  private readonly yourVote = el('div', { class: 'your-vote' });
  /** When a vote was last sent; buttons pause briefly so one click can't vote twice. */
  private voteSentAt = -Infinity;

  constructor(
    private readonly s: ClientState,
    private readonly send: (m: ClientMessage) => void,
    /** Is this chat line (key "meeting:index") being read aloud? */
    private readonly isVoiced: (key: string) => boolean = () => false,
  ) {
    // Let the AIs know you're mid-sentence so they hold their next line.
    this.input.addEventListener('input', () => {
      const now = performance.now();
      if (this.input.value.trim() && now - this.lastTypingPing > 1000) {
        this.lastTypingPing = now;
        this.send({ type: 'typing' });
      }
    });
    const form = el(
      'form',
      {
        class: 'chat-input',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = this.input.value.trim();
          if (!text) return;
          this.send({ type: 'chat', text });
          this.input.value = '';
        },
      },
      this.input,
      el('button', { type: 'submit' }, 'Send'),
    );
    this.root.append(
      el(
        'div',
        { class: 'panel meeting-panel' },
        el('div', { class: 'meeting-head' }, this.title, el('div', { class: 'meeting-right' }, this.controls, this.timer)),
        this.result,
        el('div', { class: 'meeting-body' }, this.players, el('div', { class: 'chat' }, this.log, this.typing, form)),
      ),
    );
  }

  /** Put extra buttons (e.g. mute) in the meeting header. */
  setControls(...nodes: Node[]): void {
    this.controls.replaceChildren(...nodes);
  }

  /** Refresh from the latest observation. */
  update(): void {
    const { s } = this;
    const obs = s.obs;
    const m = obs?.meeting;
    const open = !!obs && obs.phase === 'meeting' && !!m;
    const wasOpen = !this.root.classList.contains('hidden');
    show(this.root, open);
    if (!open || !obs || !m) return;
    if (!wasOpen) setTimeout(() => this.input.focus(), 50);

    if (m.index !== this.shownIndex) {
      this.shownIndex = m.index;
      this.shownLines = 0;
      this.log.replaceChildren();
      this.reveals.clear();
      this.cards.clear();
      this.voteSentAt = -Infinity;
    }
    const area = m.bodyAreaId && s.nav ? s.nav.area(m.bodyAreaId).name : 'somewhere';
    this.title.textContent =
      m.reason === 'body' && m.victimId
        ? `${nameOf(s, m.calledBy)} found ${nameOf(s, m.victimId)}'s body in ${area}`
        : `${nameOf(s, m.calledBy)} called an emergency meeting`;
    const stage = m.stage === 'discussion' ? 'Discussion' : m.stage === 'voting' ? 'Voting' : 'Result';
    this.timer.textContent = m.stage === 'result' ? stage : `${stage} · ${Math.ceil(m.secLeft)}s`;

    // Players and votes. The cards are built once per meeting and updated in place:
    // rebuilding them on every update (20 a second) swapped the Vote buttons out from under
    // the mouse mid-click, so clicks never landed.
    const me = obs.self;
    if (this.cards.size === 0) this.buildCards(obs.roster);
    const sending = performance.now() - this.voteSentAt < 1500;
    const canVote = m.stage === 'voting' && me.alive && m.participants.includes(me.id) && m.myVote === null;
    for (const r of obs.roster) {
      const c = this.cards.get(r.id);
      if (!c) continue;
      const alive = m.participants.includes(r.id);
      c.root.classList.toggle('gone', !alive);
      c.root.classList.toggle('picked', m.myVote === r.id);
      show(c.voted, m.voted.includes(r.id));
      show(c.dead, !alive);
      show(c.vote, canVote && alive);
      c.vote.disabled = sending;
    }
    show(this.skip, canVote);
    this.skip.disabled = sending;
    this.yourVote.textContent = m.myVote ? `You voted: ${m.myVote === 'skip' ? 'skip' : nameOf(s, m.myVote)}` : '';

    // New chat lines. Yours appear at once; the AIs' are revealed word by word in tick().
    m.chat.slice(this.shownLines).forEach((c, i) => {
      const key = `${m.index}:${this.shownLines + i}`;
      const mine = c.playerId === s.you;
      const span = el('span', { class: 'text' }, mine ? c.text : '');
      this.log.append(
        el(
          'div',
          { class: `line${mine ? ' mine' : ''}` },
          el('span', { class: 'who', style: `color:${hex(colorOf(s, c.playerId))}` }, nameOf(s, c.playerId)),
          span,
        ),
      );
      if (!mine) {
        const voiced = this.isVoiced(key);
        this.reveals.set(key, { span, full: c.text, voiced, created: performance.now(), segments: [], spokenDone: false, typeFrom: null, complete: false });
      }
      this.s.typing.delete(c.playerId);
    });
    if (m.chat.length > this.shownLines) this.log.scrollTop = this.log.scrollHeight;
    this.shownLines = m.chat.length;

    const canTalk = me.alive && m.participants.includes(me.id) && m.stage !== 'result';
    this.input.disabled = !canTalk;
    this.input.placeholder = canTalk ? 'Say something... (Enter to send)' : me.alive ? 'The meeting is wrapping up' : 'Ghosts cannot talk';

    if (m.stage === 'result' && m.result) {
      const r = m.result;
      this.result.textContent = r.ejectedId
        ? `${nameOf(s, r.ejectedId)} was ejected.${r.revealedRole ? ` ${nameOf(s, r.ejectedId)} was ${r.revealedRole === 'saboteur' ? 'a SABOTEUR' : 'crew'}.` : ''}`
        : `Nobody was ejected (${r.tie ? 'tie' : 'skipped'}).`;
      this.result.className = `result ${r.revealedRole === 'saboteur' ? 'good' : r.ejectedId ? 'bad' : ''}`;
    } else {
      show(this.result, false);
    }
  }

  /** A sentence of a voiced line is about to play: reveal its words as it's spoken. */
  addSpoken(sp: Spoken): void {
    const r = this.reveals.get(sp.key);
    if (!r || !r.voiced || r.typeFrom !== null || r.complete) return;
    r.segments.push({ words: sp.text.trim().split(/\s+/).filter(Boolean), start: sp.startMs, dur: Math.max(1, sp.durationMs) });
  }

  /** A voiced line finished; if none of it was heard, type it out instead. */
  lineDone(key: string, spoke: boolean): void {
    const r = this.reveals.get(key);
    if (!r || r.complete) return;
    if (spoke) r.spokenDone = true;
    else if (r.segments.length === 0) r.typeFrom = performance.now();
    else this.finish(r); // cut off part-way (e.g. muted): just show it all
  }

  /** Per-frame: typing indicator and word-by-word reveals. */
  tick(now: number): void {
    const who = [...this.s.typing].filter(([, until]) => until > now).map(([id]) => nameOf(this.s, id));
    this.typing.textContent = who.length > 0 ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing...` : '';

    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    let changed = false;
    for (const r of this.reveals.values()) {
      if (r.complete) continue;
      if (r.voiced && r.typeFrom === null && r.segments.length === 0 && now - r.created > VOICE_WAIT_MS) r.typeFrom = now;
      const text = r.voiced && r.typeFrom === null ? this.voicedText(r, now) : this.typedText(r, now);
      if (r.span.textContent !== text) {
        r.span.textContent = text;
        changed = true;
      }
    }
    if (changed && atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private voicedText(r: Reveal, now: number): string {
    if (r.segments.length === 0) return '...';
    const words: string[] = [];
    for (const seg of r.segments) {
      if (now < seg.start) return words.join(' ') || '...';
      const frac = Math.min(1, (now - seg.start) / seg.dur);
      words.push(...seg.words.slice(0, Math.ceil(frac * seg.words.length)));
      if (frac < 1) return words.join(' ');
    }
    if (r.spokenDone) return this.finish(r);
    return words.join(' ');
  }

  private typedText(r: Reveal, now: number): string {
    const n = Math.floor(((now - (r.typeFrom ?? r.created)) / 1000) * TYPE_CPS);
    return n >= r.full.length ? this.finish(r) : r.full.slice(0, n);
  }

  private finish(r: Reveal): string {
    r.complete = true;
    r.span.textContent = r.full;
    return r.full;
  }

  private buildCards(roster: { id: PlayerId; name: string; color: string }[]): void {
    const nodes: HTMLElement[] = [];
    for (const r of roster) {
      const voted = el('span', { class: 'badge hidden' }, 'voted');
      const dead = el('span', { class: 'badge dead hidden' }, 'dead');
      const vote = el('button', { class: 'vote hidden', type: 'button', onclick: () => this.vote(r.id) }, 'Vote');
      const root = el(
        'div',
        { class: 'card' },
        el('span', { class: 'dot', style: `background:${hex(r.color)}` }),
        el('span', { class: 'name' }, r.id === this.s.you ? `${r.name} (you)` : r.name),
        voted,
        dead,
        vote,
      );
      this.cards.set(r.id, { root, voted, dead, vote });
      nodes.push(root);
    }
    this.players.replaceChildren(...nodes, this.skip, this.yourVote);
  }

  private vote(target: PlayerId | 'skip'): void {
    this.voteSentAt = performance.now();
    this.send({ type: 'act', action: { type: 'vote', target } });
  }
}

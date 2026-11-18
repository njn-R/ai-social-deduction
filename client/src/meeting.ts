import type { PlayerId } from '../../src/engine';
import type { ClientMessage } from '../../src/shared/protocol';
import { hex } from './colors';
import { el, kids, show } from './dom';
import { colorOf, nameOf, type ClientState } from './state';

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

  constructor(
    private readonly s: ClientState,
    private readonly send: (m: ClientMessage) => void,
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
    }
    const area = m.bodyAreaId && s.nav ? s.nav.area(m.bodyAreaId).name : 'somewhere';
    this.title.textContent =
      m.reason === 'body' && m.victimId
        ? `${nameOf(s, m.calledBy)} found ${nameOf(s, m.victimId)}'s body in ${area}`
        : `${nameOf(s, m.calledBy)} called an emergency meeting`;
    const stage = m.stage === 'discussion' ? 'Discussion' : m.stage === 'voting' ? 'Voting' : 'Result';
    this.timer.textContent = m.stage === 'result' ? stage : `${stage} · ${Math.ceil(m.secLeft)}s`;

    // Players and votes.
    const me = obs.self;
    const canVote = m.stage === 'voting' && me.alive && m.participants.includes(me.id) && m.myVote === null;
    const card = (id: PlayerId) => {
      const r = obs.roster.find((x) => x.id === id)!;
      const alive = m.participants.includes(id);
      const voted = m.voted.includes(id);
      const mine = m.myVote === id;
      const vote = canVote && alive ? el('button', { class: 'vote', onclick: () => this.vote(id) }, 'Vote') : null;
      return el(
        'div',
        { class: `card${alive ? '' : ' gone'}${mine ? ' picked' : ''}` },
        el('span', { class: 'dot', style: `background:${hex(r.color)}` }),
        el('span', { class: 'name' }, id === s.you ? `${r.name} (you)` : r.name),
        voted ? el('span', { class: 'badge' }, 'voted') : null,
        !alive ? el('span', { class: 'badge dead' }, 'dead') : null,
        vote,
      );
    };
    this.players.replaceChildren(
      ...kids(
        ...obs.roster.map((r) => card(r.id)),
        canVote ? el('button', { class: 'vote skip', onclick: () => this.vote('skip') }, 'Skip vote') : null,
        m.myVote ? el('div', { class: 'your-vote' }, `You voted: ${m.myVote === 'skip' ? 'skip' : nameOf(s, m.myVote)}`) : null,
      ),
    );

    // New chat lines.
    for (const c of m.chat.slice(this.shownLines)) {
      this.log.append(
        el(
          'div',
          { class: `line${c.playerId === s.you ? ' mine' : ''}` },
          el('span', { class: 'who', style: `color:${hex(colorOf(s, c.playerId))}` }, nameOf(s, c.playerId)),
          el('span', { class: 'text' }, c.text),
        ),
      );
      this.s.typing.delete(c.playerId);
    }
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

  /** Typing indicator changes every frame, so it's separate from update(). */
  tick(now: number): void {
    const who = [...this.s.typing].filter(([, until]) => until > now).map(([id]) => nameOf(this.s, id));
    this.typing.textContent = who.length > 0 ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing...` : '';
  }

  private vote(target: PlayerId | 'skip'): void {
    this.send({ type: 'act', action: { type: 'vote', target } });
  }
}

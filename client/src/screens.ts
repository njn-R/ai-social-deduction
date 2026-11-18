import type { RoleChoice } from '../../src/shared/protocol';
import { describeOutcome } from './outcome';
import { el, show } from './dom';
import { renderMarkdown } from './markdown';
import { nameOf, type ClientState } from './state';

const KEYS = [
  ['WASD / arrows', 'move'],
  ['E', 'do a task'],
  ['R', 'report a body'],
  ['B', 'emergency button (in Commons)'],
  ['Q', 'kill (saboteurs)'],
];

/** Start screen: name, role, start. */
export class Lobby {
  readonly root = el('div', { class: 'overlay lobby' });
  private readonly status = el('div', { class: 'status' }, 'Connecting to the game server...');
  private readonly name = el('input', { type: 'text', maxlength: '14', value: localStorageGet('name') ?? '', placeholder: 'Your name' });
  private readonly role = el('select', {}, el('option', { value: 'random' }, 'Random role'), el('option', { value: 'crew' }, 'Crew'), el('option', { value: 'saboteur' }, 'Saboteur'));
  private readonly start = el('button', { type: 'submit', disabled: true }, 'Start game');
  private readonly voiceBox = el('input', { type: 'checkbox' });
  private readonly voiceStatus = el('div', { class: 'status' });
  private readonly voiceRate = el(
    'select',
    {},
    el('option', { value: '1' }, 'Normal'),
    el('option', { value: '1.15' }, 'Faster'),
    el('option', { value: '1.3' }, 'Fastest'),
  );

  constructor(
    onStart: (name: string, role: RoleChoice) => void,
    voice: { on: boolean; onToggle: (on: boolean) => void; rate: number; onRate: (rate: number) => void },
  ) {
    this.voiceBox.checked = voice.on;
    this.voiceBox.addEventListener('change', () => voice.onToggle(this.voiceBox.checked));
    this.voiceRate.value = String(voice.rate);
    if (this.voiceRate.selectedIndex < 0) this.voiceRate.value = '1.15';
    this.voiceRate.addEventListener('change', () => voice.onRate(Number(this.voiceRate.value)));
    const form = el(
      'form',
      {
        class: 'panel lobby-panel',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const name = this.name.value.trim() || 'Player';
          localStorageSet('name', name);
          onStart(name, this.role.value as RoleChoice);
        },
      },
      el('h1', {}, 'Deep Station'),
      el('p', { class: 'sub' }, 'A social-deduction game against an AI crew. Somewhere on this station, two of them are saboteurs.'),
      el('label', {}, 'Name', this.name),
      el('label', {}, 'Role', this.role),
      el('label', { class: 'check' }, this.voiceBox, 'Read AI lines aloud (voices run in your browser)'),
      el('label', {}, 'Voice speed', this.voiceRate),
      this.voiceStatus,
      this.start,
      this.status,
      el('div', { class: 'keys' }, ...KEYS.map(([k, v]) => el('div', {}, el('kbd', {}, k), ` ${v}`))),
    );
    this.root.append(form);
  }

  ready(model: string, fake: boolean): void {
    this.status.textContent = fake ? 'Connected. AI: canned replies (no model)' : `Connected. AI model: ${model}`;
    this.start.disabled = false;
  }

  setVoiceStatus(text: string): void {
    this.voiceStatus.textContent = text;
  }

  disconnected(): void {
    this.status.textContent = 'Lost the game server. Is it still running? Reload to retry.';
    this.start.disabled = true;
  }

  setVisible(v: boolean): void {
    show(this.root, v);
    if (v) setTimeout(() => this.name.focus(), 50);
  }
}

/** Big centred message, e.g. your role at the start. */
export class Banner {
  readonly root = el('div', { class: 'banner hidden' });
  private timer = 0;

  flash(title: string, sub: string, kind: string, ms = 3800): void {
    this.root.className = `banner ${kind}`;
    this.root.replaceChildren(el('div', { class: 'big' }, title), el('div', {}, sub));
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => show(this.root, false), ms);
  }
}

/** Small notices, e.g. "too far from the task". */
export class Toasts {
  readonly root = el('div', { class: 'toasts' });

  push(text: string): void {
    const t = el('div', { class: 'toast' }, text);
    this.root.append(t);
    setTimeout(() => t.remove(), 3000);
  }
}

/** End screen with the full reveal. */
export class GameOver {
  readonly root = el('div', { class: 'overlay gameover hidden' });

  constructor(private readonly onAgain: () => void) {}

  open(s: ClientState): void {
    const over = s.over!;
    const { title, line, kind } = describeOutcome(s);
    const saboteurs = Object.entries(over.roles).filter(([, r]) => r === 'saboteur').map(([id]) => nameOf(s, id));
    const reveal = el('div', { class: 'reveal' });
    reveal.innerHTML = renderMarkdown(over.reveal);
    this.root.replaceChildren(
      el(
        'div',
        { class: 'panel gameover-panel' },
        el('div', { class: `outcome ${kind}` }, el('h1', {}, title), el('p', {}, line)),
        el('p', {}, `The saboteurs were ${saboteurs.join(' and ')}.`),
        el('button', { onclick: () => this.onAgain() }, 'Play again'),
        el('h2', {}, 'What everyone was really thinking'),
        reveal,
      ),
    );
    show(this.root, true);
  }

  close(): void {
    show(this.root, false);
  }
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(`deep-station:${key}`);
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(`deep-station:${key}`, value);
  } catch {
    // private mode etc.: just don't remember
  }
}

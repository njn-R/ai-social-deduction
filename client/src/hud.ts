import type { Action } from '../../src/engine';
import { available, type ActionKey } from './actions';
import { el, show } from './dom';
import { nameOf, type ClientState } from './state';

const BUTTONS: { key: ActionKey; label: string }[] = [
  { key: 'E', label: 'Use' },
  { key: 'R', label: 'Report' },
  { key: 'B', label: 'Meeting' },
  { key: 'Q', label: 'Kill' },
];

/** Role, task list, task bar, action buttons and key hints shown while walking around. */
export class Hud {
  readonly root = el('div', { class: 'hud hidden' });
  private readonly role = el('div', { class: 'role' });
  private readonly tasks = el('ul', { class: 'tasks' });
  private readonly barFill = el('div', { class: 'bar-fill' });
  private readonly barText = el('div', { class: 'bar-text' });
  private readonly status = el('div', { class: 'status hidden' });
  private readonly info = el('div', { class: 'info' });
  private readonly buttons = new Map<ActionKey, { root: HTMLButtonElement; detail: HTMLElement }>();

  constructor(
    private readonly s: ClientState,
    onAction: (action: Action) => void,
  ) {
    // Built once and updated in place, so they stay clickable.
    const pad = el('div', { class: 'action-pad' });
    for (const b of BUTTONS) {
      const detail = el('small', {});
      const root = el(
        'button',
        {
          class: `act act-${b.key}`,
          type: 'button',
          onclick: () => {
            const hit = available(this.s).actions.find((a) => a.key === b.key);
            if (hit) onAction(hit.action);
          },
        },
        el('kbd', {}, b.key),
        el('span', { class: 'act-label' }, b.label),
        detail,
      );
      root.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus on the game
      this.buttons.set(b.key, { root, detail });
      pad.append(root);
    }
    this.root.append(
      el('div', { class: 'panel hud-left' }, this.role, el('div', { class: 'hud-title' }, 'Your tasks'), this.tasks),
      el('div', { class: 'taskbar' }, el('div', { class: 'bar' }, this.barFill), this.barText),
      this.status,
      pad,
      el('div', { class: 'panel move-hint' }, el('kbd', {}, 'W A S D'), el('span', {}, 'or'), el('kbd', {}, 'arrow keys'), el('span', {}, 'to move')),
      this.info,
    );
  }

  update(): void {
    const { s } = this;
    const obs = s.obs;
    show(this.root, !!obs && obs.phase === 'playing');
    if (!obs || !s.nav) return;
    const me = obs.self;

    const partner = obs.saboteurTeam.map((id) => nameOf(s, id)).join(', ');
    this.role.className = `role ${me.role}`;
    this.role.replaceChildren(
      el('strong', {}, me.role === 'saboteur' ? 'SABOTEUR' : 'CREW'),
      el('span', {}, me.role === 'saboteur' && partner ? ` with ${partner}` : ''),
      el('span', { class: 'dead' }, me.alive ? '' : ' · dead'),
    );

    this.tasks.replaceChildren(
      ...(me.role === 'saboteur' ? [el('li', { class: 'note' }, 'Fake tasks: do them to blend in')] : []),
      ...me.tasks.map((t) => {
        const st = s.nav!.station(t.stationId);
        return el('li', { class: t.done ? 'done' : '' }, el('span', {}, st.name), el('small', {}, s.nav!.area(st.areaId).name));
      }),
    );

    const pct = Math.round(obs.taskProgress * 100);
    this.barFill.style.width = `${pct}%`;
    this.barText.textContent = `Crew tasks ${pct}%`;

    const { actions, status, reasons } = available(s);
    for (const [key, b] of this.buttons) {
      const hit = actions.find((a) => a.key === key);
      const relevant = key === 'Q' ? me.role === 'saboteur' && me.alive : key === 'E' || me.alive;
      show(b.root, relevant);
      b.root.disabled = !hit;
      b.root.title = hit ? hit.label : (reasons[key] ?? '');
      b.detail.textContent = hit ? hit.target : (reasons[key] ?? '');
    }
    this.status.textContent = status ?? '';
    show(this.status, !!status);
    this.info.textContent = `Round ${obs.round} · AI: ${s.model}`;
  }
}

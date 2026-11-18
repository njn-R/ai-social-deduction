import { available } from './actions';
import { el, kids, show } from './dom';
import { nameOf, type ClientState } from './state';

/** Role, task list, task bar and key hints shown while walking around. */
export class Hud {
  readonly root = el('div', { class: 'hud hidden' });
  private readonly role = el('div', { class: 'role' });
  private readonly tasks = el('ul', { class: 'tasks' });
  private readonly barFill = el('div', { class: 'bar-fill' });
  private readonly barText = el('div', { class: 'bar-text' });
  private readonly actions = el('div', { class: 'actions' });
  private readonly info = el('div', { class: 'info' });

  constructor(private readonly s: ClientState) {
    this.root.append(
      el('div', { class: 'panel hud-left' }, this.role, el('div', { class: 'hud-title' }, 'Your tasks'), this.tasks),
      el('div', { class: 'taskbar' }, el('div', { class: 'bar' }, this.barFill), this.barText),
      this.actions,
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
      ...kids(
        el('strong', {}, me.role === 'saboteur' ? 'SABOTEUR' : 'CREW'),
        me.role === 'saboteur' && partner ? el('span', {}, ` with ${partner}`) : null,
        !me.alive ? el('span', { class: 'dead' }, ' · dead') : null,
      ),
    );

    this.tasks.replaceChildren(
      ...me.tasks.map((t) => {
        const st = s.nav!.station(t.stationId);
        return el('li', { class: t.done ? 'done' : '' }, el('span', {}, st.name), el('small', {}, s.nav!.area(st.areaId).name));
      }),
    );
    if (me.role === 'saboteur') this.tasks.prepend(el('li', { class: 'note' }, 'Fake tasks: do them to blend in'));

    const pct = Math.round(obs.taskProgress * 100);
    this.barFill.style.width = `${pct}%`;
    this.barText.textContent = `Crew tasks ${pct}%`;

    const { actions, status } = available(s);
    this.actions.replaceChildren(
      ...kids(
        ...actions.map((a) => el('div', { class: 'action' }, el('kbd', {}, a.key), el('span', {}, a.label))),
        status ? el('div', { class: 'status' }, status) : null,
      ),
    );
    this.info.textContent = `Round ${obs.round} · AI: ${s.model}`;
  }
}

import { dist, type Action } from '../../src/engine';
import { nameOf, type ClientState } from './state';

export type ActionKey = 'E' | 'R' | 'Q' | 'B';

export interface Available {
  key: ActionKey;
  /** Full description, e.g. 'Do "Repair water purifier"'. */
  label: string;
  /** Short target for an on-screen button, e.g. "Repair water purifier". */
  target: string;
  action: Action;
}

/** Why each key can't be used right now (shown on its button). */
export type Reasons = Partial<Record<ActionKey, string>>;

/**
 * What the player can do right now, from their own observation. The server checks
 * everything again; this decides which buttons light up and what a key press sends.
 */
export function available(s: ClientState): { actions: Available[]; status: string | null; reasons: Reasons } {
  const obs = s.obs;
  const nav = s.nav;
  const cfg = s.config;
  const reasons: Reasons = {};
  if (!obs || !nav || !cfg || obs.phase !== 'playing') return { actions: [], status: null, reasons };
  const me = obs.self;
  const actions: Available[] = [];

  if (me.busy) {
    const st = nav.station(me.busy.stationId);
    return { actions, status: `Working on "${st.name}"... ${me.busy.secLeft.toFixed(1)}s (moving cancels it)`, reasons: { E: 'working...' } };
  }

  if (me.alive || (me.role === 'crew' && cfg.ghostsDoTasks)) {
    const task = me.tasks
      .filter((t) => !t.done)
      .map((t) => nav.station(t.stationId))
      .filter((st) => dist(st.pos, me.pos) <= cfg.taskRange)
      .sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos))[0];
    if (task) actions.push({ key: 'E', label: `${me.role === 'saboteur' ? 'Fake' : 'Do'} "${task.name}"`, target: task.name, action: { type: 'start_task', stationId: task.id } });
    else reasons.E = me.tasks.every((t) => t.done) ? 'all tasks done' : 'stand at a yellow task';
  }

  let status: string | null = null;
  if (me.alive) {
    const body = obs.visibleBodies.filter((b) => dist(b.pos, me.pos) <= cfg.reportRange).sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos))[0];
    if (body) actions.push({ key: 'R', label: `Report ${nameOf(s, body.victimId)}'s body`, target: `${nameOf(s, body.victimId)}'s body`, action: { type: 'report', bodyId: body.id } });
    else reasons.R = 'no body nearby';

    if (me.role === 'saboteur') {
      if ((me.killCooldownSec ?? 0) > 0) {
        reasons.Q = `ready in ${Math.ceil(me.killCooldownSec ?? 0)}s`;
      } else {
        const team = new Set(obs.saboteurTeam);
        const target = obs.visiblePlayers
          .filter((v) => v.alive && !team.has(v.id) && dist(v.pos, me.pos) <= cfg.killRange)
          .sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos))[0];
        if (target) actions.push({ key: 'Q', label: `Kill ${nameOf(s, target.id)}`, target: nameOf(s, target.id), action: { type: 'kill', targetId: target.id } });
        else reasons.Q = 'get close to someone';
      }
    }

    const nearButton = dist(s.map!.button.pos, me.pos) <= cfg.buttonRange;
    if (me.emergencyLeft <= 0) reasons.B = 'already used';
    else if (obs.buttonReadyInSec > 0) reasons.B = `ready in ${Math.ceil(obs.buttonReadyInSec)}s`;
    else if (!nearButton) reasons.B = 'go to the red button';
    else actions.push({ key: 'B', label: 'Call an emergency meeting', target: 'Call everyone', action: { type: 'call_meeting' } });
  } else {
    status = me.role === 'crew' ? "You're a ghost. Finish your tasks to help the crew win." : "You're out. Your partner is on their own now.";
  }
  return { actions, status, reasons };
}

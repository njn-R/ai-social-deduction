import { describe, expect, it } from 'vitest';
import { Game, secToTicks, STATION_MAP } from '../src/engine';
import { DEFAULT_ROSTER } from '../src/sim/roster';
import { makeGame, openVoting, place, stepSec, stepTicks, TWO_ROOMS } from './helpers';

// Two spots side by side inside Commons.
const A = { x: 26.5, y: 18.5 };
const B = { x: 27.5, y: 18.5 };

describe('setup', () => {
  const deal = (seed: number) => new Game({ map: STATION_MAP, players: DEFAULT_ROSTER.slice(0, 9), seed });
  const roles = (g: Game) => g.players.map((p) => p.role).join(',');

  it('deals the configured number of saboteurs, the same way for the same seed', () => {
    expect(deal(1).players.filter((p) => p.role === 'saboteur')).toHaveLength(2);
    expect(roles(deal(1))).toBe(roles(deal(1)));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => roles(deal(s)))).size).toBeGreaterThan(1);
  });

  it('gives everyone 2 long and 3 short tasks, no repeats', () => {
    for (const p of deal(3).players) {
      const kinds = p.tasks.map((t) => STATION_MAP.stations.find((s) => s.id === t.stationId)!.kind);
      expect(kinds.filter((k) => k === 'long')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'short')).toHaveLength(3);
      expect(new Set(p.tasks.map((t) => t.stationId)).size).toBe(5);
    }
  });

  it('rejects setups where saboteurs would not start outnumbered', () => {
    expect(() => makeGame({ players: 4, saboteurs: ['p0', 'p1'] })).toThrow(/outnumbered/);
  });
});

describe('movement', () => {
  it('moves at player speed', () => {
    const g = makeGame();
    place(g, 'p1', A);
    g.setMove('p1', { x: 1, y: 0 });
    stepSec(g, 1);
    expect(g.player('p1').pos.x).toBeCloseTo(A.x + g.config.playerSpeed, 5);
  });

  it('stops at walls', () => {
    const g = makeGame();
    place(g, 'p1', { x: 26.5, y: 17 });
    g.setMove('p1', { x: 0, y: -1 });
    stepSec(g, 2);
    expect(g.player('p1').pos.y).toBeGreaterThanOrEqual(16);
    expect(g.nav.isWalkable(g.player('p1').pos)).toBe(true);
  });
});

describe('kills', () => {
  it('only lets a saboteur kill crew who are in range and off cooldown', () => {
    const g = makeGame({ config: { initialKillCooldownSec: 5 } });
    place(g, 'p0', A);
    place(g, 'p1', B);
    expect(g.act('p1', { type: 'kill', targetId: 'p0' })).toEqual({ ok: false, reason: 'only saboteurs can kill' });
    expect(g.act('p0', { type: 'kill', targetId: 'p1' })).toEqual({ ok: false, reason: 'kill is on cooldown' });

    stepSec(g, 5);
    place(g, 'p1', { x: A.x + 4, y: A.y });
    expect(g.act('p0', { type: 'kill', targetId: 'p1' })).toEqual({ ok: false, reason: 'target is out of range' });

    place(g, 'p1', B);
    expect(g.act('p0', { type: 'kill', targetId: 'p1' }).ok).toBe(true);
    expect(g.player('p1').alive).toBe(false);
    expect(g.state.bodies).toMatchObject([{ victimId: 'p1', areaId: 'commons' }]);
    expect(g.player('p0').killCooldownTicks).toBe(secToTicks(g.config.killCooldownSec));
    expect(g.act('p0', { type: 'kill', targetId: 'p2' }).ok).toBe(false);
  });

  it('cannot kill through a wall', () => {
    const g = makeGame({ map: TWO_ROOMS, config: { longTasks: 1, shortTasks: 1 } });
    place(g, 'p0', { x: 4.9, y: 1.5 });
    place(g, 'p1', { x: 6.1, y: 1.5 });
    expect(g.act('p0', { type: 'kill', targetId: 'p1' })).toEqual({ ok: false, reason: 'no clear line to the target' });
  });

  it('cannot kill a fellow saboteur', () => {
    const g = makeGame({ players: 6, saboteurs: ['p0', 'p1'] });
    place(g, 'p0', A);
    place(g, 'p1', B);
    expect(g.act('p0', { type: 'kill', targetId: 'p1' }).ok).toBe(false);
  });

  it('ends the game when saboteurs reach parity', () => {
    const g = makeGame({ config: { killCooldownSec: 0 } });
    place(g, 'p0', A);
    for (const victim of ['p1', 'p2', 'p3']) {
      place(g, victim, g.player('p0').pos);
      expect(g.act('p0', { type: 'kill', targetId: victim }).ok).toBe(true);
    }
    expect(g.result).toMatchObject({ winner: 'saboteurs', reason: 'parity' });
    expect(g.act('p0', { type: 'kill', targetId: 'p4' })).toEqual({ ok: false, reason: 'the game is over' });
  });
});

describe('reports and meetings', () => {
  it('reporting a body starts a meeting, clears bodies and reveals the dead', () => {
    const g = makeGame();
    place(g, 'p0', A);
    place(g, 'p1', B);
    g.act('p0', { type: 'kill', targetId: 'p1' });
    const body = g.state.bodies[0];

    place(g, 'p2', { x: body.pos.x + 6, y: body.pos.y });
    expect(g.act('p2', { type: 'report', bodyId: body.id })).toEqual({ ok: false, reason: 'too far from the body' });

    place(g, 'p2', { x: body.pos.x + 2, y: body.pos.y });
    expect(g.act('p2', { type: 'report', bodyId: body.id }).ok).toBe(true);
    expect(g.phase).toBe('meeting');
    expect(g.state.meeting).toMatchObject({ reason: 'body', calledBy: 'p2', victimId: 'p1', bodyAreaId: 'commons' });
    expect(g.state.meeting!.participants).not.toContain('p1');
    expect(g.state.bodies).toEqual([]);
    expect(g.state.publicDead).toEqual(['p1']);
  });

  it('dead players cannot report', () => {
    const g = makeGame();
    place(g, 'p0', A);
    place(g, 'p1', B);
    g.act('p0', { type: 'kill', targetId: 'p1' });
    expect(g.act('p1', { type: 'report', bodyId: g.state.bodies[0].id }).ok).toBe(false);
  });

  it('the emergency button has a cooldown, a range and one use per player', () => {
    const g = makeGame({ config: { emergencyCooldownSec: 2 } });
    place(g, 'p1', g.map.button.pos);
    expect(g.act('p1', { type: 'call_meeting' })).toEqual({ ok: false, reason: 'the button is not ready yet' });
    stepSec(g, 2);
    place(g, 'p1', A);
    expect(g.act('p1', { type: 'call_meeting' })).toEqual({ ok: false, reason: 'too far from the button' });
    place(g, 'p1', g.map.button.pos);
    expect(g.act('p1', { type: 'call_meeting' }).ok).toBe(true);
    expect(g.state.meeting?.reason).toBe('emergency');

    // Finish the meeting, then try again.
    stepTicks(g, 1);
    for (const id of g.state.meeting!.participants) g.act(id, { type: 'vote', target: 'skip' });
    stepSec(g, g.config.resultSec);
    expect(g.phase).toBe('playing');
    stepSec(g, 2);
    place(g, 'p1', g.map.button.pos);
    expect(g.act('p1', { type: 'call_meeting' })).toEqual({ ok: false, reason: 'no emergency meetings left' });
  });

  it('only allows chat from living participants, and only during meetings', () => {
    const g = makeGame();
    expect(g.act('p1', { type: 'chat', text: 'hi' }).ok).toBe(false);
    openVoting(g);
    expect(g.act('p1', { type: 'chat', text: '   ' })).toEqual({ ok: false, reason: 'empty message' });
    expect(g.act('p1', { type: 'chat', text: 'P0 is sus', accuse: 'p0' }).ok).toBe(true);
    expect(g.state.meeting!.chat).toMatchObject([{ playerId: 'p1', text: 'P0 is sus', accuse: 'p0' }]);
  });
});

describe('voting', () => {
  it('is closed during discussion', () => {
    const g = makeGame({ config: { discussionSec: 5 } });
    place(g, 'p1', g.map.button.pos);
    g.act('p1', { type: 'call_meeting' });
    expect(g.act('p1', { type: 'vote', target: 'skip' })).toEqual({ ok: false, reason: 'voting is not open' });
    stepSec(g, 5);
    expect(g.act('p1', { type: 'vote', target: 'skip' }).ok).toBe(true);
  });

  it('ejects the plurality pick, reveals the role, and resolves as soon as everyone votes', () => {
    const g = makeGame();
    openVoting(g);
    for (const id of ['p1', 'p2', 'p3']) g.act(id, { type: 'vote', target: 'p0' });
    g.act('p4', { type: 'vote', target: 'skip' });
    expect(g.state.meeting!.stage).toBe('voting');
    expect(g.act('p4', { type: 'vote', target: 'p1' })).toEqual({ ok: false, reason: 'already voted' });
    g.act('p0', { type: 'vote', target: 'p1' });

    expect(g.state.meeting!.result).toMatchObject({ ejectedId: 'p0', tie: false, revealedRole: 'saboteur', tally: { p0: 3, skip: 1, p1: 1 } });
    expect(g.player('p0')).toMatchObject({ alive: false, ejected: true });
    stepSec(g, g.config.resultSec);
    expect(g.result).toMatchObject({ winner: 'crew', reason: 'saboteurs_ejected' });
  });

  it('ejects nobody on a tie', () => {
    const g = makeGame();
    openVoting(g);
    g.act('p1', { type: 'vote', target: 'p2' });
    g.act('p3', { type: 'vote', target: 'p2' });
    g.act('p2', { type: 'vote', target: 'p1' });
    g.act('p4', { type: 'vote', target: 'p1' });
    g.act('p0', { type: 'vote', target: 'skip' });
    expect(g.state.meeting!.result).toMatchObject({ ejectedId: null, tie: true });
  });

  it('ejects nobody when skip wins', () => {
    const g = makeGame();
    openVoting(g);
    for (const id of ['p0', 'p1', 'p2']) g.act(id, { type: 'vote', target: 'skip' });
    g.act('p3', { type: 'vote', target: 'p4' });
    g.act('p4', { type: 'vote', target: 'p3' });
    expect(g.state.meeting!.result).toMatchObject({ ejectedId: null, tie: false });
  });

  it('closes at the timer; players who did not vote abstain', () => {
    const g = makeGame();
    openVoting(g);
    g.act('p1', { type: 'vote', target: 'p2' });
    stepSec(g, g.config.votingSec);
    expect(g.state.meeting!.result).toMatchObject({ ejectedId: 'p2', revealedRole: 'crew' });
  });

  it('hides the role when confirmEjects is off', () => {
    const g = makeGame({ config: { confirmEjects: false } });
    openVoting(g);
    g.act('p1', { type: 'vote', target: 'p2' });
    stepSec(g, g.config.votingSec);
    expect(g.state.meeting!.result!.revealedRole).toBeNull();
  });

  it('starts the next round back at the table with kill cooldowns reset', () => {
    const g = makeGame({ players: 7, saboteurs: ['p0', 'p1'] });
    openVoting(g, 'p2');
    for (const id of g.state.meeting!.participants) g.act(id, { type: 'vote', target: 'skip' });
    stepSec(g, g.config.resultSec);
    expect(g.phase).toBe('playing');
    expect(g.state.round).toBe(2);
    g.players.forEach((p, i) => expect(p.pos).toEqual(g.map.seats[i]));
    expect(g.player('p0').killCooldownTicks).toBe(secToTicks(g.config.killCooldownSec));
  });
});

describe('tasks', () => {
  it('needs you at the station and takes the task duration', () => {
    const g = makeGame();
    const task = g.player('p1').tasks[0];
    const station = g.nav.station(task.stationId);
    expect(g.act('p1', { type: 'start_task', stationId: task.stationId })).toEqual({ ok: false, reason: 'too far from the task' });
    expect(g.act('p1', { type: 'start_task', stationId: 'not-mine' })).toEqual({ ok: false, reason: 'not one of your tasks' });

    place(g, 'p1', station.pos);
    expect(g.act('p1', { type: 'start_task', stationId: task.stationId }).ok).toBe(true);
    const ticks = secToTicks(station.kind === 'long' ? g.config.longTaskSec : g.config.shortTaskSec);
    stepTicks(g, ticks - 1);
    expect(g.player('p1').tasks[0].done).toBe(false);
    stepTicks(g, 1);
    expect(g.player('p1').tasks[0].done).toBe(true);
    expect(g.taskProgress().done).toBe(1);
  });

  it('is cancelled by moving', () => {
    const g = makeGame();
    const task = g.player('p1').tasks[0];
    place(g, 'p1', g.nav.station(task.stationId).pos);
    g.act('p1', { type: 'start_task', stationId: task.stationId });
    stepTicks(g, 5);
    g.setMove('p1', { x: 1, y: 0 });
    expect(g.player('p1').busy).toBeNull();
    stepSec(g, 10);
    expect(g.player('p1').tasks[0].done).toBe(false);
  });

  it('saboteur tasks are fake and never move the task bar', () => {
    const g = makeGame();
    const task = g.player('p0').tasks[0];
    place(g, 'p0', g.nav.station(task.stationId).pos);
    g.act('p0', { type: 'start_task', stationId: task.stationId });
    stepSec(g, 10);
    expect(g.player('p0').tasks[0].done).toBe(true);
    expect(g.taskProgress().done).toBe(0);
    expect(g.events.find((e) => e.type === 'task_completed')).toMatchObject({ playerId: 'p0', fake: true });
  });

  it('crew win when every crew task is done, ghosts included', () => {
    const g = makeGame({ config: { longTasks: 0, shortTasks: 1 } });
    place(g, 'p0', A);
    place(g, 'p1', B);
    g.act('p0', { type: 'kill', targetId: 'p1' });
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const task = g.player(id).tasks[0];
      place(g, id, g.nav.station(task.stationId).pos);
      expect(g.act(id, { type: 'start_task', stationId: task.stationId }).ok, id).toBe(true);
    }
    stepSec(g, g.config.shortTaskSec);
    expect(g.result).toMatchObject({ winner: 'crew', reason: 'tasks' });
  });
});

describe('time limit', () => {
  it('ends with no winner when time runs out', () => {
    const g = makeGame({ config: { maxGameSec: 1 } });
    stepSec(g, 1);
    expect(g.result).toMatchObject({ winner: 'none', reason: 'timeout' });
  });
});

describe('observations', () => {
  it('only show players within vision and line of sight', () => {
    const g = makeGame();
    place(g, 'p0', { x: 55.5, y: 7.5 }); // far away in the Lab
    place(g, 'p1', { x: 27.5, y: 16.5 });
    place(g, 'p2', { x: 29.5, y: 16.5 }); // same room, close
    place(g, 'p3', { x: 27.5, y: 10.5 }); // 6 tiles away but behind the Sonar wall
    place(g, 'p4', { x: 37.5, y: 27.5 }); // same room, too far
    expect(g.observe('p1').visiblePlayers.map((v) => v.id)).toEqual(['p2']);
  });

  it('hide ghosts from the living but show bodies', () => {
    const g = makeGame();
    place(g, 'p0', A);
    place(g, 'p1', B);
    g.act('p0', { type: 'kill', targetId: 'p1' });
    place(g, 'p0', { x: 55.5, y: 7.5 });
    place(g, 'p2', { x: 29.5, y: 18.5 });
    const obs = g.observe('p2');
    expect(obs.visiblePlayers.map((v) => v.id)).not.toContain('p1');
    expect(obs.visibleBodies.map((b) => b.victimId)).toEqual(['p1']);
    expect(g.observe('p1').visiblePlayers.map((v) => v.id)).toContain('p2'); // ghosts still see the living
  });

  it('tell saboteurs who their teammates are and tell crew nothing about roles', () => {
    const g = makeGame({ players: 6, saboteurs: ['p0', 'p1'] });
    expect(g.observe('p0').saboteurTeam).toEqual(['p1']);
    const crewObs = g.observe('p2');
    expect(crewObs.saboteurTeam).toEqual([]);
    expect(JSON.stringify(crewObs.roster)).not.toContain('saboteur');
    expect(crewObs.self.killCooldownSec).toBeNull();
  });

  it('cannot see through a one-tile wall', () => {
    const g = makeGame({ map: TWO_ROOMS, config: { longTasks: 1, shortTasks: 1 } });
    place(g, 'p0', { x: 4.9, y: 1.5 });
    place(g, 'p1', { x: 6.1, y: 1.5 });
    expect(g.observe('p1').visiblePlayers.map((v) => v.id)).not.toContain('p0');
  });
});

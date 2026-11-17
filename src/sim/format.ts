import { TICK_RATE, type Game, type GameEvent, type GameResult } from '../engine';

export function formatClock(tick: number): string {
  const sec = Math.floor(tick / TICK_RATE);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

export function describeResult(r: GameResult): string {
  const why = {
    tasks: 'all tasks done',
    saboteurs_ejected: 'every saboteur ejected',
    parity: 'saboteurs reached parity',
    timeout: 'time limit hit',
  }[r.reason];
  const who = r.winner === 'none' ? 'No winner' : r.winner === 'crew' ? 'Crew win' : 'Saboteurs win';
  return `${who} (${why})`;
}

/** One line of the omniscient spectator log, or null for noisy events. */
export function formatEvent(e: GameEvent, game: Game, opts: { tasks?: boolean } = {}): string | null {
  const name = (id: string) => game.player(id).name;
  const area = (id: string | null) => (id ? game.nav.area(id).name : 'an unknown spot');
  const t = `[${formatClock(e.tick)}]`;
  switch (e.type) {
    case 'game_started': {
      const sabs = Object.entries(e.roles).filter(([, r]) => r === 'saboteur').map(([id]) => name(id));
      return `${t} Game starts. Saboteurs: ${sabs.join(', ')}`;
    }
    case 'task_started':
    case 'task_cancelled':
      return null;
    case 'task_completed':
      if (!opts.tasks) return null;
      return `${t} ${name(e.playerId)} ${e.fake ? 'faked' : 'finished'} "${game.nav.station(e.stationId).name}"`;
    case 'kill':
      return `${t} ** ${name(e.killerId)} killed ${name(e.victimId)} in ${area(e.areaId)} **`;
    case 'meeting_called':
      return e.reason === 'body'
        ? `${t} ${name(e.callerId)} reported ${name(e.victimId!)}'s body in ${area(e.bodyAreaId)}`
        : `${t} ${name(e.callerId)} called an emergency meeting`;
    case 'voting_started':
      return `${t} Voting opens`;
    case 'chat':
      return `${t}   ${name(e.playerId)}: ${e.text}`;
    case 'vote_cast':
      return `${t}   ${name(e.voterId)} votes ${e.target === 'skip' ? 'skip' : name(e.target)}`;
    case 'meeting_result': {
      const r = e.result;
      if (r.ejectedId) return `${t} ${name(r.ejectedId)} was ejected${r.revealedRole ? ` (${r.revealedRole})` : ''}`;
      return `${t} Nobody was ejected (${r.tie ? 'tie' : 'skipped'})`;
    }
    case 'round_started':
      return `${t} Round ${e.round} begins`;
    case 'game_over':
      return `${t} GAME OVER: ${describeResult(e.result)}`;
  }
}

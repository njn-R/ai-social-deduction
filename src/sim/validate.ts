import type { Game, PlayerId } from '../engine';

/**
 * Cross-checks a finished game's final state against its event log.
 * Returns a list of problems; empty means the game is consistent.
 */
export function checkInvariants(game: Game): string[] {
  const problems: string[] = [];
  const r = game.result;
  if (!r) return ['game has no result'];
  const events = game.events;
  const { crew, saboteurs } = game.aliveCounts();
  const progress = game.taskProgress();

  switch (r.reason) {
    case 'tasks':
      if (r.winner !== 'crew') problems.push('task win not credited to crew');
      if (progress.done !== progress.total) problems.push(`task win with ${progress.done}/${progress.total} tasks done`);
      break;
    case 'saboteurs_ejected':
      if (r.winner !== 'crew') problems.push('ejection win not credited to crew');
      if (saboteurs !== 0) problems.push(`crew won by ejection but ${saboteurs} saboteurs are alive`);
      break;
    case 'parity':
      if (r.winner !== 'saboteurs') problems.push('parity win not credited to saboteurs');
      if (saboteurs === 0 || saboteurs < crew) problems.push(`parity win with ${saboteurs} saboteurs vs ${crew} crew`);
      break;
    case 'timeout':
      if (r.winner !== 'none') problems.push('timeout should have no winner');
      break;
  }

  const killed = new Set<PlayerId>();
  const ejected = new Set<PlayerId>();
  for (const e of events) {
    if (e.type === 'kill') {
      if (game.player(e.killerId).role !== 'saboteur') problems.push(`${e.killerId} killed but is not a saboteur`);
      if (game.player(e.victimId).role !== 'crew') problems.push(`${e.victimId} was killed but is not crew`);
      if (killed.has(e.victimId) || ejected.has(e.victimId)) problems.push(`${e.victimId} died twice`);
      if (killed.has(e.killerId) || ejected.has(e.killerId)) problems.push(`${e.killerId} killed while dead`);
      killed.add(e.victimId);
    }
    if (e.type === 'meeting_result' && e.result.ejectedId) {
      if (killed.has(e.result.ejectedId) || ejected.has(e.result.ejectedId)) problems.push(`${e.result.ejectedId} ejected while dead`);
      ejected.add(e.result.ejectedId);
    }
    if (e.type === 'vote_cast' && (killed.has(e.voterId) || ejected.has(e.voterId))) problems.push(`${e.voterId} voted while dead`);
    if (e.type === 'chat' && (killed.has(e.playerId) || ejected.has(e.playerId))) problems.push(`${e.playerId} chatted while dead`);
  }

  for (const p of game.players) {
    const dead = killed.has(p.id) || ejected.has(p.id);
    if (p.alive === dead) problems.push(`${p.id} alive=${p.alive} but the log says dead=${dead}`);
    if (p.ejected !== ejected.has(p.id)) problems.push(`${p.id} ejected flag disagrees with the log`);
  }

  for (let i = 1; i < events.length; i++) {
    if (events[i].tick < events[i - 1].tick) problems.push(`event ${i} goes back in time`);
  }
  if (events.at(-1)?.type !== 'game_over') problems.push('log does not end with game_over');
  if (events.filter((e) => e.type === 'game_over').length !== 1) problems.push('expected exactly one game_over');
  return problems;
}

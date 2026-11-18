import type { ClientState } from './state';

const WHY = {
  tasks: 'The crew finished every task.',
  saboteurs_ejected: 'Every saboteur was voted out.',
  parity: 'The saboteurs equal the crew in number.',
  timeout: 'Time ran out.',
};

/** The headline for the end screen, from the player's point of view. */
export function describeOutcome(s: ClientState): { title: string; line: string; kind: 'win' | 'loss' | 'draw' } {
  const over = s.over!;
  const myRole = s.you ? over.roles[s.you] : undefined;
  const winners = over.result.winner;
  if (winners === 'none') return { title: 'No winner', line: WHY[over.result.reason], kind: 'draw' };
  const won = (winners === 'crew' && myRole === 'crew') || (winners === 'saboteurs' && myRole === 'saboteur');
  const side = winners === 'crew' ? 'The crew wins' : 'The saboteurs win';
  return { title: won ? 'You win!' : 'You lose', line: `${side}. ${WHY[over.result.reason]}`, kind: won ? 'win' : 'loss' };
}

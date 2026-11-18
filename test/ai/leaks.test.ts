import { describe, expect, it } from 'vitest';
import { findRoleLeak } from '../../src/ai/leaks';

describe('findRoleLeak', () => {
  it.each(["I'm the saboteur, sorry", 'As a saboteur I would never', 'My partner and I were in Sonar', 'I killed Mo, fine', 'we saboteurs stick together'])(
    'blocks: %s',
    (line) => expect(findRoleLeak(line)).not.toBeNull(),
  );

  it.each(["I'm not a saboteur!", 'Vex is the saboteur.', 'Which of you is the killer?', 'I saw Mo in the Lab', 'I am the captain here'])(
    'allows: %s',
    (line) => expect(findRoleLeak(line)).toBeNull(),
  );
});

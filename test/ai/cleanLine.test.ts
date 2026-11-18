import { describe, expect, it } from 'vitest';
import { cleanLine } from '../../src/ai/agent';

describe('cleanLine', () => {
  it('drops stray characters from other scripts', () => {
    expect(cleanLine('I saw you both in the돔.')).toBe('I saw you both in the.');
  });

  it('keeps normal punctuation, numbers and accented letters', () => {
    expect(cleanLine("One: Vex was in Sonar at 0:45. Café's closed? Curious!")).toBe("One: Vex was in Sonar at 0:45. Café's closed? Curious!");
  });

  it('strips wrapping quotes and squashes whitespace', () => {
    expect(cleanLine('  "I was in   the Lab"  ')).toBe('I was in the Lab');
  });
});

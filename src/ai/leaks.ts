const ROLE = '(?:saboteurs?|impostors?|imposters?|killers?|traitors?)';

const PATTERNS: RegExp[] = [
  new RegExp(`\\bI(?:'m|’m| am)\\s+(?:a|the|one of the)\\s+${ROLE}\\b`, 'i'),
  new RegExp(`\\bas\\s+(?:a|the)\\s+${ROLE}\\b`, 'i'),
  new RegExp(`\\bwe\\s+${ROLE}\\b`, 'i'),
  /\b(?:my|our)\s+(?:fellow\s+)?(?:saboteur|partner|accomplice|teammate)\b/i,
  /\bfellow\s+saboteurs?\b/i,
  /\bI\s+(?:killed|murdered|stabbed)\b/i,
];

/**
 * Catches a line where a player gives away their own secret role ("I'm the saboteur",
 * "my partner and I"). Denials like "I'm not a saboteur" pass. Returns the offending
 * phrase, or null when the line is safe to say.
 */
export function findRoleLeak(say: string): string | null {
  for (const p of PATTERNS) {
    const m = p.exec(say);
    if (m) return m[0];
  }
  return null;
}

import type { Reasoning } from './llm/types';

export type Tier = 'rookie' | 'average' | 'sharp' | 'mastermind';

/**
 * What separates the tiers. All agents share one model, so skill comes from what each
 * agent notices, remembers, and is handed by the notebook.
 */
export interface TierProfile {
  tier: Tier;
  /** Chance of not noticing a player who comes into view. */
  missChance: number;
  /** Chance a sighting is remembered as the wrong person. */
  mixupChance: number;
  /** Sightings older than this are forgotten. Null = perfect memory. */
  memorySpanSec: number | null;
  /** How many sightings make it into the prompt. */
  maxSightings: number;
  /**
   * 0 = raw memories only
   * 1 = + meeting history
   * 2 = + claims checked against sightings
   * 3 = + who-suspects-whom, and a safe lie when saboteur
   */
  notebook: 0 | 1 | 2 | 3;
  /** Hidden reasoning before answering. Costs seconds, so it's used for round plans only. */
  reasoning: Reasoning;
  /** Word budget for the private 'thoughts' field. */
  thoughtWords: number;
  skill: string;
}

export const TIERS: Record<Tier, TierProfile> = {
  rookie: {
    tier: 'rookie',
    missChance: 0.3,
    mixupChance: 0.12,
    memorySpanSec: 60,
    maxSightings: 6,
    notebook: 0,
    reasoning: 'none',
    thoughtWords: 25,
    skill: 'You are a beginner. You notice little, mix people up, and are easily swayed by whoever sounds confident.',
  },
  average: {
    tier: 'average',
    missChance: 0.1,
    mixupChance: 0.03,
    memorySpanSec: 150,
    maxSightings: 12,
    notebook: 1,
    reasoning: 'none',
    thoughtWords: 40,
    skill: 'You are an ordinary player. You remember the basics but rarely dig deeper.',
  },
  sharp: {
    tier: 'sharp',
    missChance: 0,
    mixupChance: 0,
    memorySpanSec: null,
    maxSightings: 30,
    notebook: 2,
    reasoning: 'none',
    thoughtWords: 60,
    skill: 'You are a sharp player. Cross-check what people claim against your notes before you trust them.',
  },
  mastermind: {
    tier: 'mastermind',
    missChance: 0,
    mixupChance: 0,
    memorySpanSec: null,
    maxSightings: 40,
    notebook: 3,
    reasoning: 'low',
    thoughtWords: 80,
    skill:
      'You are an expert. Think several steps ahead: hunt for contradictions, track who is pushing whom, and when you lie, tell lies nobody can disprove.',
  },
};

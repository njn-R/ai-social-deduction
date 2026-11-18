import type { PlayerId } from '../engine';

export type JournalKind = 'plan' | 'turn' | 'vote' | 'error' | 'blocked';

/** One private moment for the post-game reveal: what an AI thought, and what it did with it. */
export interface JournalEntry {
  tick: number;
  playerId: PlayerId;
  kind: JournalKind;
  thoughts: string;
  /** Hidden model reasoning, when the tier allows it. */
  reasoning?: string;
  /** What they said out loud (turns), or decided (plans, votes). */
  said?: string;
  detail?: string;
  latencyMs?: number;
}

export class Journal {
  readonly entries: JournalEntry[] = [];
  private readonly listeners = new Set<(e: JournalEntry) => void>();

  add(entry: JournalEntry): void {
    this.entries.push(entry);
    for (const fn of this.listeners) fn(entry);
  }

  onEntry(fn: (e: JournalEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  count(kind: JournalKind): number {
    return this.entries.filter((e) => e.kind === kind).length;
  }
}

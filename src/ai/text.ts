import { TICK_RATE } from '../engine';

/** Game clock as m:ss. */
export function clock(tick: number): string {
  const sec = Math.max(0, Math.floor(tick / TICK_RATE));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Parse "m:ss" (or "ss") back to a tick, or null. */
export function parseClock(text: string): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const sec = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return Number.isFinite(sec) ? sec * TICK_RATE : null;
}

export function span(from: number, to: number): string {
  return to - from < TICK_RATE * 2 ? clock(from) : `${clock(from)}-${clock(to)}`;
}

export function words(text: string, max: number): string {
  const parts = text.trim().split(/\s+/);
  return parts.length <= max ? text.trim() : `${parts.slice(0, max).join(' ')}...`;
}

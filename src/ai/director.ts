import { secToTicks, TICK_RATE, type ChatMessage, type Game, type MeetingState, type PlayerId, type Rng } from '../engine';
import type { AiAgent, Turn } from './agent';

/** Reading-speed pacing for games with a human at the table. */
export interface Pacing {
  /** Pause after every line, in seconds. */
  baseSec: number;
  /** Plus reading time for the previous line. */
  charsPerSec: number;
  /** Cap on the total pause. */
  maxSec: number;
  /** Longest an AI line waits while `hold()` says to (a human typing, a line being spoken). */
  holdMaxSec: number;
}

export const HUMAN_PACING: Pacing = { baseSec: 3.5, charsPerSec: 20, maxSec: 10, holdMaxSec: 20 };

export interface DirectorOptions {
  /** Most lines one player gets per meeting. */
  maxTurns: number;
  /** Don't start a new line when less discussion time than this remains. */
  minSecLeft: number;
  /** Called when an AI starts (true) and stops (false) composing a line, for a "typing..." indicator. */
  onTyping?: (playerId: PlayerId, typing: boolean) => void;
  /** Slow the conversation to reading speed (games with a human). Null = post as soon as ready. */
  pacing?: Pacing | null;
  /** True while the next line should wait: a human is typing, or a line is still being read aloud. */
  hold?: () => boolean;
}

const DEFAULTS: DirectorOptions = { maxTurns: 3, minSecLeft: 3 };

/** A finished AI line held back until the room has had time to read the last one. */
interface Held {
  id: PlayerId;
  turn: Turn;
  /** Chat length when the line was requested; anything newer is something it didn't hear. */
  heardUpTo: number;
}

/**
 * Runs the meeting conversation: picks who talks next (one line at a time, so each
 * speaker hears the line before), and asks everyone for their vote when voting opens.
 * It only uses public information: who's alive, who said what, who was accused.
 */
export class MeetingDirector {
  private meetingIndex = -1;
  private readonly turns = new Map<PlayerId, number>();
  private lineInFlight = false;
  private votesAsked = false;
  private held: Held | null = null;
  private holdingSince: number | null = null;
  private readonly opts: DirectorOptions;

  constructor(
    private readonly game: Game,
    private readonly agents: Map<PlayerId, AiAgent>,
    private readonly rng: Rng,
    opts: Partial<DirectorOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  update(): void {
    const m = this.game.state.meeting;
    if (!m || this.game.phase !== 'meeting') return;
    if (m.index !== this.meetingIndex) {
      this.meetingIndex = m.index;
      this.turns.clear();
      this.lineInFlight = false;
      this.votesAsked = false;
      this.dropHeld();
    }
    if (m.stage === 'result') {
      this.dropHeld();
      return;
    }
    // The meeting began during this tick (someone reported or pressed the button while
    // acting), so not every agent has seen it yet. Start the conversation next tick.
    if (this.game.tick <= m.startTick) return;
    if (m.stage === 'voting' && !this.votesAsked) this.askForVotes(m);
    if (this.held && !this.releaseHeld(m)) return;
    if (m.stage !== 'discussion' || this.lineInFlight) return;
    if ((m.stageEndsTick - this.game.tick) / TICK_RATE < this.opts.minSecLeft) return;

    const pick = this.pickSpeaker(m);
    if (!pick) return;
    this.lineInFlight = true;
    this.turns.set(pick.id, (this.turns.get(pick.id) ?? 0) + 1);
    this.opts.onTyping?.(pick.id, true);
    const index = m.index;
    const heardUpTo = m.chat.length;
    pick.agent.requestTurn(pick.cue, (turn) => {
      this.lineInFlight = false;
      const now = this.game.state.meeting;
      if (!turn || !turn.say || now?.index !== index || now.stage === 'result') {
        this.opts.onTyping?.(pick.id, false);
        return;
      }
      this.held = { id: pick.id, turn, heardUpTo };
      this.holdingSince = null;
      if (!this.opts.pacing) this.releaseHeld(now);
    });
  }

  /**
   * Post the held line once the room has had time to read the previous one and nobody is
   * mid-sentence. If a human spoke since the line was written, it missed that, so it's
   * thrown away and the speaker gets a fresh turn. Returns true when nothing is held anymore.
   */
  private releaseHeld(m: MeetingState): boolean {
    const held = this.held!;
    const pacing = this.opts.pacing;
    if (pacing) {
      const missed = m.chat.slice(held.heardUpTo).some((c) => !this.agents.has(c.playerId));
      if (missed) {
        this.turns.set(held.id, Math.max(0, (this.turns.get(held.id) ?? 1) - 1));
        this.dropHeld();
        return true;
      }
      const last = m.chat.at(-1);
      if (last) {
        const pauseSec = Math.min(pacing.maxSec, pacing.baseSec + last.text.length / pacing.charsPerSec);
        if (this.game.tick - last.tick < secToTicks(pauseSec)) return false;
      }
      if (this.opts.hold?.()) {
        this.holdingSince ??= this.game.tick;
        if (this.game.tick - this.holdingSince < secToTicks(pacing.holdMaxSec)) return false;
      }
    }
    this.held = null;
    this.holdingSince = null;
    this.opts.onTyping?.(held.id, false);
    this.game.act(held.id, {
      type: 'chat',
      text: held.turn.say,
      ...(held.turn.accuse ? { accuse: held.turn.accuse } : {}),
      ...(held.turn.claims.length > 0 ? { claims: held.turn.claims } : {}),
    });
    return true;
  }

  private dropHeld(): void {
    if (this.held) this.opts.onTyping?.(this.held.id, false);
    this.held = null;
    this.holdingSince = null;
  }

  private askForVotes(m: MeetingState): void {
    this.votesAsked = true;
    for (const id of m.participants) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      agent.requestVote((target) => {
        const now = this.game.state.meeting;
        if (now?.index === m.index && now.stage === 'voting' && now.votes[id] === undefined) this.game.act(id, { type: 'vote', target });
      });
    }
  }

  private pickSpeaker(m: MeetingState): { id: PlayerId; agent: AiAgent; cue: string } | null {
    const chat = m.chat;
    const name = (id: PlayerId) => this.game.player(id).name;
    const candidates = m.participants.filter((id) => this.agents.has(id) && (this.turns.get(id) ?? 0) < this.opts.maxTurns);
    if (candidates.length === 0) return null;

    if (chat.length === 0 && (this.turns.get(m.calledBy) ?? 0) === 0 && candidates.includes(m.calledBy)) {
      const cue =
        m.reason === 'body'
          ? 'You reported the body, so you speak first. Say where you found it and anything you noticed.'
          : 'You pressed the emergency button, so you speak first. Say why you called the meeting.';
      return { id: m.calledBy, agent: this.agents.get(m.calledBy)!, cue };
    }

    const last = chat.at(-1);
    const recent = chat.slice(-3);
    let best: { id: PlayerId; agent: AiAgent; cue: string; score: number } | null = null;
    for (const id of candidates) {
      const agent = this.agents.get(id)!;
      const spoken = this.turns.get(id) ?? 0;
      let score = 1 + 2 * agent.persona.traits.talkativeness - 1.3 * spoken + this.rng.next() * 1.5;
      let cue = 'Your turn to talk. Add something useful, question someone, or stay quiet.';

      const accusedBy = lastWhere(recent, (c) => c.accuse === id && c.playerId !== id);
      const answered = accusedBy ? chat.slice(chat.indexOf(accusedBy) + 1).some((c) => c.playerId === id) : true;
      const mentionedBy = lastWhere(recent, (c) => c.playerId !== id && mentions(c.text, name(id)));
      if (accusedBy && !answered) {
        score += 4;
        cue = `${name(accusedBy.playerId)} just accused you. Respond.`;
      } else if (mentionedBy) {
        score += 2;
        cue = `${name(mentionedBy.playerId)} just mentioned you.`;
      }
      if (last?.playerId === id) score -= 5;
      if (!best || score > best.score) best = { id, agent, cue, score };
    }
    return best;
  }
}

function lastWhere(msgs: ChatMessage[], pred: (c: ChatMessage) => boolean): ChatMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (pred(msgs[i])) return msgs[i];
  return undefined;
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

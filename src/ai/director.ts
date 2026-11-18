import { TICK_RATE, type ChatMessage, type Game, type MeetingState, type PlayerId, type Rng } from '../engine';
import type { AiAgent } from './agent';

export interface DirectorOptions {
  /** Most lines one player gets per meeting. */
  maxTurns: number;
  /** Don't start a new line when less discussion time than this remains. */
  minSecLeft: number;
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

  constructor(
    private readonly game: Game,
    private readonly agents: Map<PlayerId, AiAgent>,
    private readonly rng: Rng,
    private readonly opts: DirectorOptions = { maxTurns: 3, minSecLeft: 3 },
  ) {}

  update(): void {
    const m = this.game.state.meeting;
    if (!m || this.game.phase !== 'meeting') return;
    if (m.index !== this.meetingIndex) {
      this.meetingIndex = m.index;
      this.turns.clear();
      this.lineInFlight = false;
      this.votesAsked = false;
    }
    if (m.stage === 'result') return;
    // The meeting began during this tick (someone reported or pressed the button while
    // acting), so not every agent has seen it yet. Start the conversation next tick.
    if (this.game.tick <= m.startTick) return;
    if (m.stage === 'voting' && !this.votesAsked) this.askForVotes(m);
    if (m.stage !== 'discussion' || this.lineInFlight) return;
    if ((m.stageEndsTick - this.game.tick) / TICK_RATE < this.opts.minSecLeft) return;

    const pick = this.pickSpeaker(m);
    if (!pick) return;
    this.lineInFlight = true;
    this.turns.set(pick.id, (this.turns.get(pick.id) ?? 0) + 1);
    const index = m.index;
    pick.agent.requestTurn(pick.cue, (turn) => {
      this.lineInFlight = false;
      const now = this.game.state.meeting;
      if (!turn || !turn.say || now?.index !== index || now.stage === 'result') return;
      this.game.act(pick.id, {
        type: 'chat',
        text: turn.say,
        ...(turn.accuse ? { accuse: turn.accuse } : {}),
        ...(turn.claims.length > 0 ? { claims: turn.claims } : {}),
      });
    });
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

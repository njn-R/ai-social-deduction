import {
  dist,
  NavGrid,
  Rng,
  secToTicks,
  type ChatMessage,
  type GameConfig,
  type MeetingResult,
  type Observation,
  type PlayerId,
  type VoteTarget,
} from '../engine';
import type { ControlApi, Controller } from './controller';
import { Reflexes } from './reflexes';

export interface ScriptedBotOptions {
  id: PlayerId;
  nav: NavGrid;
  config: GameConfig;
  seed: number;
}

/**
 * A simple rule-based player, used to exercise the engine without an LLM.
 *
 * Play comes from the shared Reflexes (tasks, reporting, kill-and-run).
 * On top of that it remembers who was standing near a body and who accused whom,
 * and talks and votes from that with canned lines.
 *
 * It only ever reads its own Observation, so it plays by the same rules an LLM agent does.
 */
export class ScriptedBot implements Controller {
  readonly id: PlayerId;
  private readonly nav: NavGrid;
  private readonly config: GameConfig;
  private readonly rng: Rng;
  private readonly reflexes: Reflexes;

  // Memory (built only from observations).
  private readonly suspicion = new Map<PlayerId, number>();
  private readonly seenBodies = new Set<string>();
  private prevVisible = new Set<PlayerId>();
  private lastArea: string | null = null;
  private round = 0;

  // Per-meeting state.
  private meetingIndex = -1;
  private chatAtTick = 0;
  private voteAtTick = -1;
  private chatted = false;
  private chatSeen = 0;
  private learnedFromResult = false;
  private readonly accusations = new Map<PlayerId, number>();

  constructor(opts: ScriptedBotOptions) {
    this.id = opts.id;
    this.nav = opts.nav;
    this.config = opts.config;
    this.rng = new Rng(opts.seed);
    this.reflexes = new Reflexes(opts.nav, opts.config, this.rng);
  }

  update(obs: Observation, api: ControlApi): void {
    if (obs.phase === 'ended') return;
    if (obs.phase === 'meeting') {
      this.reflexes.pause();
      this.inMeeting(obs, api);
      return;
    }
    if (obs.round !== this.round) {
      this.round = obs.round;
      this.prevVisible = new Set();
    }
    this.perceive(obs);
    this.reflexes.play(obs, api);
  }

  private perceive(obs: Observation): void {
    const me = obs.self;
    if (me.areaId) this.lastArea = me.areaId;
    if (me.alive && me.role === 'crew') {
      for (const body of obs.visibleBodies) {
        if (this.seenBodies.has(body.id)) continue;
        this.seenBodies.add(body.id);
        const near = obs.visiblePlayers.filter((v) => v.alive && dist(v.pos, body.pos) <= 4);
        const onTop = near.filter((v) => dist(v.pos, body.pos) <= 1.2);
        if (this.prevVisible.has(body.victimId) && onTop.length > 0) {
          // The victim was alive in view a moment ago and someone is on the body: a witnessed kill.
          for (const v of onTop) this.bump(v.id, onTop.length === 1 ? 1 : 0.6);
        } else {
          for (const v of near) this.bump(v.id, 0.3);
        }
      }
    }
    this.prevVisible = new Set(obs.visiblePlayers.filter((v) => v.alive).map((v) => v.id));
  }

  private bump(id: PlayerId, amount: number): void {
    if (id === this.id) return;
    this.suspicion.set(id, Math.min(2, (this.suspicion.get(id) ?? 0) + amount));
  }

  // ── Meetings ───────────────────────────────────────────────────────────

  private inMeeting(obs: Observation, api: ControlApi): void {
    const m = obs.meeting;
    if (!m) return;
    if (m.index !== this.meetingIndex) {
      this.meetingIndex = m.index;
      this.chatted = false;
      this.chatSeen = 0;
      this.voteAtTick = -1;
      this.learnedFromResult = false;
      this.accusations.clear();
      const latest = Math.max(1.5, Math.min(15, this.config.discussionSec * 0.6));
      this.chatAtTick = obs.tick + secToTicks(this.rng.range(1, latest));
    }
    for (; this.chatSeen < m.chat.length; this.chatSeen++) this.hear(m.chat[this.chatSeen], obs);

    if (m.stage === 'result' && m.result && !this.learnedFromResult) {
      this.learnedFromResult = true;
      this.learn(m.result);
    }
    if (!obs.self.alive || !m.participants.includes(this.id)) return;

    if (!this.chatted && m.stage !== 'result' && obs.tick >= this.chatAtTick) {
      this.chatted = true;
      this.speak(obs, api);
    }
    if (m.stage === 'voting' && m.myVote === null) {
      if (this.voteAtTick < 0) this.voteAtTick = obs.tick + secToTicks(this.rng.range(0.5, Math.max(0.6, Math.min(5, this.config.votingSec * 0.5))));
      if (obs.tick >= this.voteAtTick) api.act({ type: 'vote', target: this.chooseVote(obs) });
    }
  }

  private hear(msg: ChatMessage, obs: Observation): void {
    if (!msg.accuse || msg.playerId === this.id) return;
    this.accusations.set(msg.accuse, (this.accusations.get(msg.accuse) ?? 0) + 1);
    if (obs.self.role !== 'crew') return;
    if (msg.accuse === this.id) this.bump(msg.playerId, 0.4); // I know I'm innocent, so they're wrong or lying
    else this.bump(msg.accuse, 0.35);
  }

  private speak(obs: Observation, api: ControlApi): void {
    const m = obs.meeting!;
    const me = obs.self;
    const name = (id: PlayerId) => obs.roster.find((r) => r.id === id)?.name ?? id;
    const areaName = (id: string | null) => (id ? this.nav.area(id).name : 'somewhere');
    const say = (text: string, accuse?: PlayerId) => api.act({ type: 'chat', text, ...(accuse ? { accuse } : {}) });

    if (me.role === 'crew') {
      const suspect = this.topSuspect(m.participants);
      if (suspect && suspect.score >= 1) say(`I saw ${name(suspect.id)} standing over the body. It was them.`, suspect.id);
      else if (suspect && suspect.score >= 0.5) say(`${name(suspect.id)} looks suspicious to me.`, suspect.id);
      else if (m.reason === 'body' && m.calledBy === me.id && m.victimId) say(`I found ${name(m.victimId)}'s body in ${areaName(m.bodyAreaId)}.`);
      else say(`I didn't see anything. I was in ${areaName(this.lastArea)}.`);
      return;
    }

    const team = new Set(obs.saboteurTeam);
    const crew = m.participants.filter((id) => id !== me.id && !team.has(id));
    if (crew.length > 0 && this.rng.chance(0.35)) {
      const piled = crew.filter((id) => (this.accusations.get(id) ?? 0) > 0);
      const target = piled.length > 0 ? this.mostAccused(piled) : this.rng.pick(crew);
      say(`I think ${name(target)} is acting suspicious.`, target);
    } else {
      say(`I was doing tasks in ${areaName(this.lastArea)}. Didn't see anything.`);
    }
  }

  private chooseVote(obs: Observation): VoteTarget {
    const m = obs.meeting!;
    if (obs.self.role === 'crew') {
      const suspect = this.topSuspect(m.participants);
      return suspect && suspect.score >= 0.5 ? suspect.id : 'skip';
    }
    const team = new Set(obs.saboteurTeam);
    const accused = m.participants.filter((id) => id !== this.id && !team.has(id) && (this.accusations.get(id) ?? 0) > 0);
    return accused.length > 0 ? this.mostAccused(accused) : 'skip';
  }

  private learn(result: MeetingResult): void {
    if (result.ejectedId) this.suspicion.delete(result.ejectedId);
    for (const [id, score] of this.suspicion) {
      if (score < 1) this.suspicion.set(id, score * 0.6); // hunches fade, eyewitness memories don't
    }
  }

  private topSuspect(among: PlayerId[]): { id: PlayerId; score: number } | null {
    let best: { id: PlayerId; score: number } | null = null;
    for (const [id, score] of this.suspicion) {
      if (id === this.id || !among.includes(id)) continue;
      if (!best || score > best.score) best = { id, score };
    }
    return best;
  }

  private mostAccused(ids: PlayerId[]): PlayerId {
    return ids.reduce((a, b) => ((this.accusations.get(b) ?? 0) > (this.accusations.get(a) ?? 0) ? b : a));
  }
}

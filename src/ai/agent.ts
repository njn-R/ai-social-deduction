import type { ControlApi, Controller } from '../bots/controller';
import { Reflexes } from '../bots/reflexes';
import { Rng, type Claim, type GameConfig, type NavGrid, type Observation, type PlayerId, type VoteTarget } from '../engine';
import { Journal } from './journal';
import { findRoleLeak } from './leaks';
import type { LlmResult, Reasoning } from './llm/types';
import { PRIORITY, type LlmQueue } from './llm/queue';
import { Memory } from './memory';
import { basePolicy, type Persona } from './personas';
import { planPrompt, turnPrompt, votePrompt, type PromptParts } from './prompts';
import { crewPlanSchema, saboteurPlanSchema, turnSchema, voteSchema } from './schemas';
import { parseClock } from './text';
import { TIERS, type TierProfile } from './tiers';

export interface AgentDeps {
  persona: Persona;
  nav: NavGrid;
  config: GameConfig;
  queue: LlmQueue;
  journal: Journal;
  /** Static system prompt for this game. */
  system: string;
  /** Player id -> display name, for everyone at the table. */
  names: Map<PlayerId, string>;
  seed: number;
}

/** A meeting line, ready to post. `say` is empty when the agent chose to stay quiet. */
export interface Turn {
  say: string;
  accuse: PlayerId | null;
  claims: Claim[];
}

/**
 * Tidy a spoken line: drop wrapping quotes, stray characters from other scripts (small
 * multilingual models occasionally slip one in), and extra whitespace.
 */
export function cleanLine(text: string): string {
  return text
    .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}$+<=>^`|~]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim()
    .replace(/^["'“]+|["'”]+$/g, '')
    .trim()
    .slice(0, 280);
}

interface TurnJson {
  thoughts?: string;
  intent?: string;
  say?: string;
  accuse?: string;
  claims?: { where?: string; at?: string; saw?: string[] }[];
}

/**
 * An LLM-driven player. Reflexes handle the moment-to-moment play; the model is asked
 * only for a plan at the start of each round, meeting lines, and votes. Everything it
 * knows comes from its own observations, filtered through its tier.
 */
export class AiAgent implements Controller {
  readonly id: PlayerId;
  readonly persona: Persona;
  readonly tier: TierProfile;
  readonly memory: Memory;
  private readonly reflexes: Reflexes;
  private obs: Observation | null = null;
  private round = 0;
  private readonly idByName: Map<string, PlayerId>;
  private readonly areaByName: Map<string, string>;

  constructor(private readonly d: AgentDeps) {
    this.id = d.persona.id;
    this.persona = d.persona;
    this.tier = TIERS[d.persona.tier];
    const rng = new Rng(d.seed);
    this.memory = new Memory(this.id, this.tier, new Rng(d.seed ^ 0x5bd1e995));
    this.reflexes = new Reflexes(d.nav, d.config, rng);
    this.reflexes.policy = basePolicy(d.persona);
    this.idByName = new Map([...d.names].map(([id, name]) => [name.toLowerCase(), id]));
    this.areaByName = new Map(d.nav.map.areas.map((a) => [a.name.toLowerCase(), a.id]));
  }

  get alive(): boolean {
    return this.obs?.self.alive ?? true;
  }

  get role(): Observation['self']['role'] | null {
    return this.obs?.self.role ?? null;
  }

  update(obs: Observation, api: ControlApi): void {
    this.obs = obs;
    this.memory.observe(obs);
    if (obs.phase !== 'playing') {
      this.reflexes.pause();
      return;
    }
    if (obs.round !== this.round) {
      this.round = obs.round;
      this.reflexes.policy = basePolicy(this.persona);
      if (obs.self.alive) this.requestPlan();
    }
    this.reflexes.play(obs, {
      setMove: (dir) => api.setMove(dir),
      act: (action) => {
        const r = api.act(action);
        if (r.ok && action.type === 'kill') this.memory.noteKill(action.targetId, obs.self.areaId, obs.tick);
        return r;
      },
    });
  }

  // ── LLM calls ──────────────────────────────────────────────────────────

  /** Ask for this meeting's next line. `done(null)` on failure. */
  requestTurn(cue: string, done: (turn: Turn | null) => void): void {
    const m = this.obs?.meeting;
    if (!m || !this.alive) return done(null);
    const index = m.index;
    this.d.queue.submit({
      label: `turn:${this.id}`,
      priority: PRIORITY.meeting,
      build: () => {
        const p = this.parts();
        const others = this.namesWhere((id) => id !== this.id && p.obs.meeting!.participants.includes(id));
        return {
          label: `turn:${this.id}`,
          system: this.d.system,
          prompt: turnPrompt(p, cue),
          schema: turnSchema({ others, everyone: this.namesWhere((id) => id !== this.id), areas: this.areaNames(), thoughtChars: this.thoughtChars() }),
          maxTokens: this.maxTokens(),
          temperature: 0.85,
          reasoning: 'none',
        };
      },
      stillWanted: () => this.obs?.meeting?.index === index && this.obs.meeting.stage !== 'result',
      onDone: (r) => done(this.readTurn(r)),
      onError: (e) => {
        this.note('error', `turn failed: ${e.message}`);
        done(null);
      },
    });
  }

  /** Ask for this agent's vote. Falls back to skip on failure. */
  requestVote(done: (vote: VoteTarget) => void): void {
    const m = this.obs?.meeting;
    if (!m || !this.alive) return;
    const index = m.index;
    this.d.queue.submit({
      label: `vote:${this.id}`,
      priority: PRIORITY.vote,
      build: () => {
        const p = this.parts();
        const others = this.namesWhere((id) => id !== this.id && p.obs.meeting!.participants.includes(id));
        return {
          label: `vote:${this.id}`,
          system: this.d.system,
          prompt: votePrompt(p),
          schema: voteSchema({ others, thoughtChars: this.thoughtChars() }),
          maxTokens: this.maxTokens(),
          temperature: 0.5,
          reasoning: 'none',
        };
      },
      stillWanted: () => this.obs?.meeting?.index === index && this.obs.meeting.stage === 'voting',
      onDone: (r) => {
        const j = r.json as { thoughts?: string; vote?: string };
        const vote: VoteTarget = j.vote && j.vote !== 'skip' ? (this.idByName.get(j.vote.toLowerCase()) ?? 'skip') : 'skip';
        this.note('vote', j.thoughts ?? '', { said: vote === 'skip' ? 'skip' : this.d.names.get(vote), r });
        done(vote);
      },
      onError: (e) => {
        this.note('error', `vote failed: ${e.message}`);
        done('skip');
      },
    });
  }

  private requestPlan(): void {
    const round = this.round;
    this.d.queue.submit({
      label: `plan:${this.id}`,
      priority: PRIORITY.plan,
      build: () => {
        const p = this.parts();
        const alive = (id: PlayerId) => id !== this.id && !p.obs.roster.find((r) => r.id === id)?.knownDead;
        const sab = p.obs.self.role === 'saboteur';
        const team = new Set(p.obs.saboteurTeam);
        const schema = sab
          ? saboteurPlanSchema({ crew: this.namesWhere((id) => alive(id) && !team.has(id)), others: this.namesWhere(alive), thoughtChars: this.thoughtChars() })
          : crewPlanSchema({ others: this.namesWhere(alive), thoughtChars: this.thoughtChars() });
        return {
          label: `plan:${this.id}`,
          system: this.d.system,
          prompt: planPrompt(p),
          schema,
          maxTokens: this.maxTokens(this.tier.reasoning),
          temperature: 0.7,
          // Plans aren't time-critical (reflexes keep playing meanwhile), so this is where
          // higher tiers get to think before answering.
          reasoning: this.tier.reasoning,
        };
      },
      stillWanted: () => this.obs?.phase === 'playing' && this.obs.round === round && this.obs.self.alive,
      onDone: (r) => {
        if (this.obs?.round !== round || this.obs.phase !== 'playing') return;
        const j = r.json as { thoughts?: string; buddy?: string; avoid?: string; target?: string; style?: string };
        const policy = { ...this.reflexes.policy };
        policy.buddy = this.lookup(j.buddy);
        policy.avoid = this.lookup(j.avoid);
        policy.target = this.lookup(j.target);
        if (j.style === 'patient' || j.style === 'normal' || j.style === 'aggressive') policy.aggression = j.style;
        this.reflexes.policy = policy;
        const parts = [
          policy.buddy && `buddy ${this.d.names.get(policy.buddy)}`,
          policy.avoid && `avoid ${this.d.names.get(policy.avoid)}`,
          policy.target && `target ${this.d.names.get(policy.target)}`,
          j.style && `${j.style}`,
        ].filter(Boolean);
        this.note('plan', j.thoughts ?? '', { said: parts.join(', ') || 'no plan', r });
      },
      onError: (e) => this.note('error', `plan failed: ${e.message}`),
    });
  }

  // ── Reading replies ────────────────────────────────────────────────────

  private readTurn(r: LlmResult): Turn {
    const j = r.json as TurnJson;
    const thoughts = j.thoughts ?? '';
    let say = cleanLine(j.say ?? '');
    if (j.intent === 'stay_quiet') say = '';

    const leak = say ? findRoleLeak(say) : null;
    if (leak) {
      this.note('blocked', thoughts, { said: say, detail: `role leak: "${leak}"`, r });
      return { say: '', accuse: null, claims: [] };
    }

    // Only keep an accusation the line actually makes.
    const accused = this.lookup(j.accuse);
    const accuse = accused && say.toLowerCase().includes((this.d.names.get(accused) ?? '').toLowerCase()) ? accused : null;
    const now = this.obs?.tick ?? 0;
    const claims: Claim[] = (say ? (j.claims ?? []) : [])
      .map((c) => {
        const areaId = c.where ? this.areaByName.get(c.where.toLowerCase()) : undefined;
        const at = c.at ? parseClock(c.at) : null;
        const saw = (c.saw ?? []).map((n) => this.idByName.get(n.toLowerCase())).filter((id): id is PlayerId => !!id && id !== this.id);
        return areaId ? { areaId, atTick: at !== null && at <= now ? at : null, saw: [...new Set(saw)] } : null;
      })
      .filter((c): c is Claim => c !== null)
      .slice(0, 3);

    this.note('turn', thoughts, { said: say || '(stays quiet)', r });
    return { say, accuse, claims };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private parts(): PromptParts {
    const obs = this.obs;
    if (!obs) throw new Error(`${this.id} has no observation yet`);
    return { obs, memory: this.memory, persona: this.persona, tier: this.tier, nav: this.d.nav, config: this.d.config, name: (id) => this.d.names.get(id) ?? id };
  }

  private namesWhere(pred: (id: PlayerId) => boolean): string[] {
    return [...this.d.names].filter(([id]) => pred(id)).map(([, name]) => name);
  }

  private areaNames(): string[] {
    return this.d.nav.map.areas.map((a) => a.name);
  }

  private lookup(name: string | undefined): PlayerId | null {
    if (!name || name === 'nobody' || name === 'anyone') return null;
    const id = this.idByName.get(name.toLowerCase());
    return id && id !== this.id ? id : null;
  }

  private thoughtChars(): number {
    return this.tier.thoughtWords * 7;
  }

  private maxTokens(reasoning: Reasoning = 'none'): number {
    return reasoning === 'none' ? 450 : 1100;
  }

  private note(kind: 'plan' | 'turn' | 'vote' | 'error' | 'blocked', thoughts: string, extra: { said?: string; detail?: string; r?: LlmResult } = {}): void {
    this.d.journal.add({
      tick: this.obs?.tick ?? 0,
      playerId: this.id,
      kind,
      thoughts,
      ...(extra.r?.reasoning ? { reasoning: extra.r.reasoning } : {}),
      ...(extra.said !== undefined ? { said: extra.said } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.r ? { latencyMs: extra.r.latencyMs } : {}),
    });
  }
}

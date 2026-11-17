# Solo Social-Deduction Game with an AI Cast: Plan

*Working title: TBD (see Decision 2). Drafted 2026-11-17.*

**Status (2026-11-17):** Phases 0 and 1 done. The headless engine, a placeholder map (stand-in
deep-sea room names until a theme is picked), scripted bots and a simulator all work, and 100 bot
games run clean. Scripted bots favor the crew (~94% crew wins); balance tuning waits for real AI
agents in Phase 2. See [README.md](README.md) for commands.

## 1. Goal

A single-player social-deduction game: you plus 8 AI players on an original map. Some are secretly
saboteurs who eliminate the crew; the crew does tasks and finds the saboteurs through meetings and
votes. Every AI has its own **persona** (name, personality, way of talking, play style) and its own
**intelligence level**, so some are easy to fool and some read you like a book.

## 2. The big question: use Among Us's game files, or build from scratch?

**Build from scratch, as an original game in the same genre.**

| | Mod Among Us | Build our own |
|---|---|---|
| Legal | Art, maps, characters, name and sounds belong to Innersloth. We can't reuse or ship them, and we won't make a copy of the game's look. | Hidden traitors, tasks, meetings and votes are genre mechanics (like Werewolf or Mafia). Ours is fine. |
| Technical | Compiled Unity (IL2CPP) game. Adding AI players means reverse-engineering the netcode with BepInEx-style mods. Breaks on every game update. | We own the code, so every rule, timer and piece of state is ours to change. |
| AI quality | No clean way to get "what this bot can see right now" out of the game. | The engine hands each AI an exact, filtered view of the world. **This is what makes good AI possible.** |
| Effort | Low at first, then a never-ending maintenance fight. | More work up front, but it only goes forward. |

So we keep the genre's core loop and give it our own setting, name, map, characters and art.

## 3. Architecture

```
Browser client (Phaser)  <── WebSocket ──>  Game server (Node, holds the real game state)
  - draws map, fog of war                     ├─ Game engine: rules, 20 Hz tick, map, roles, win checks
  - your input (move, use, kill, report)      ├─ Perception filter: what each player can see right now
  - meeting chat + voting UI                  ├─ AI agents x 8
  - post-game reveal                          │    ├─ Reflexes (code): pathfinding, walking, doing tasks
                                              │    ├─ Memory: per-agent event log, fidelity set by tier
                                              │    └─ LLM brain: tactical choices + meeting talk
                                              └─ LLM gateway: LM Studio on your GPU (Claude optional), one priority queue
```

The server is the only source of truth. An AI agent never reads the game state directly. It only
gets what the perception filter gives it, the same as you.

## 4. AI agent design (the core of the project)

### 4.1 Perception and fairness
- Each tick the engine works out, per player, who and what is inside their vision radius and line
  of sight: players, bodies, someone doing a task, someone using a vent.
- These become events in the agent's memory: `t=45s saw Vex in Sonar`, `t=61s Vex walked toward Galley`.
- Saboteur agents also know who the other saboteurs are, and get a private channel.
- An automated test checks that no prompt ever contains information that agent couldn't have seen.

### 4.2 Three layers of "brain"
LLM calls take seconds, so the AI can't be an LLM steering every frame. Instead:

1. **Reflexes (plain code, every tick):** A* pathfinding, walking, doing or faking a task, keeping
   distance, fleeing. Instant and free.
2. **Tactics (mostly code, LLM only for big moments):** everyday choices (which task next, who to
   stick near, when a saboteur is safe to strike) come from a scored-options system in code, shaped
   by persona traits. The LLM is called only for big moments: a plan at round start, finding a body,
   seeing someone vent or kill, being accused. The call is **async**: the agent keeps doing its
   current plan while it "thinks". This matters because a local GPU answers one call at a time
   (section 7).
3. **Social (LLM, in meetings):** talk in character, accuse, defend, lie with an alibi, vote.

Every LLM reply is structured JSON (structured outputs), checked by the engine before use:

```jsonc
// tactics
{ "thoughts": "private, shown in the post-game reveal",
  "goal": "do_task | go_to | follow | avoid | kill | report | call_meeting | sabotage | vent | fake_task | idle",
  "target": "room or player id" }

// meeting turn
{ "thoughts": "private reasoning",
  "say": "public chat line, in character, max 2 sentences",
  "intent": "accuse | defend | question | agree | deflect | stay_quiet",
  "suspicion": { "vex": 0.7, "mo": 0.2 },
  "claims": [ { "where": "galley", "saw": ["vex"] } ] }   // fed into everyone's notebook (4.4)
```

Keeping `thoughts` apart from `say` stops agents from saying their secret out loud. A checker also
rejects any `say` that leaks a role. All the `thoughts` are shown in a **post-game reveal**, so you
can read what each AI really believed. That should be one of the most fun parts.

### 4.3 Meeting flow
- The person who reported the body (or called the meeting) speaks first.
- A discussion manager picks who talks next: the accused > whoever was just mentioned > talkative
  personas > random. While one line is on screen, it already generates the next speaker's line,
  shown with a typing indicator.
- You can type at any time. Your message is shown to everyone and they can react to it.
- Voting: every agent returns a vote and a private reason. Skip is allowed.

### 4.4 Intelligence tiers
All agents share one local model, so the tiers come from what each agent is *given*, not from
different models. The biggest lever is the **notebook**: code (not the LLM) tracks who was seen
where, who claimed what in meetings, and where claims clash. Smart agents get the notebook in
their prompt; weak ones don't. A small model with a good notebook plays far smarter than the
same model guessing from raw memory.

| Tier | Memory | Notebook | Thinking mode | As saboteur | Perception |
|---|---|---|---|---|---|
| **Rookie** | Forgets or blurs events after ~60 s, sometimes mixes up who was who | none | off | Over-explains, obvious tells | Misses ~30% of what's in view |
| **Average** | Last few events plus a short summary | Own sightings only | off | Basic alibis | Misses ~10% |
| **Sharp** | Full log of own observations | + alibi table and clashing claims | off | Keeps lies consistent, frames others | Full |
| **Mastermind** | Full log | + who suspects whom; as saboteur, "safe lies" nobody can disprove | on, when the queue has room | Plans kills around alibis, plays the long game | Full |

Optional upgrade: run Masterminds on the Claude API (Sonnet 5.5 or Opus 5.5) for a real jump in
skill. One setting, small cost per game (section 7).

We prove the tiers are really different by running batches of AI-only games and checking win
rate and vote accuracy per tier.

### 4.5 Personas
Each persona is a card. It drives both *how they talk* and *how they play*.

```yaml
id: hale
name: Professor Hale
tier: mastermind
archetype: methodical detective
traits: { boldness: 0.3, suspicion: 0.7, honesty: 0.8, talkativeness: 0.5, chaos: 0.1 }
voice: "Precise and polite. Numbered points. Never uses slang."
quirks: ["Quotes timestamps", "Says 'curious' when it spots a contradiction"]
sample_lines: ["One: Vex was in Sonar at 0:45. Two: the body was in the Galley at 0:50. Curious."]  # keeps small models in voice
as_crew: "Builds alibi timelines, asks pointed questions, slow to vote"
as_saboteur: "Frames whoever has the weakest alibi, offers a tidy fake timeline"
relationships: { vex: "finds Vex reckless", mo: "protective of Mo" }
```

Starter cast (we'd make about 12 and pick 8 per game):

| Name | Tier | Archetype | Signature move |
|---|---|---|---|
| Professor Hale | Mastermind | Methodical detective | Builds timelines, quotes timestamps |
| Whisper | Sharp | Quiet loner | Says little, then drops one damning observation |
| Captain Vex | Sharp | Loud self-made leader | Accuses fast, pushes the vote |
| Jinx | Average | Chaotic joker | Jokes, random accusations, sometimes throws a vote |
| Saint | Average | Trusting peacemaker | Defends people, pushes to skip without proof |
| Mo | Rookie | Anxious newbie | Follows others, forgets where they were, panics when accused |
| Duke | Rookie | Overconfident bluffer | "Saw" things that never happened |

Later (Phase 4): **memory between games.** Personas remember who accused them, who lied, and who
they trust, so the cast builds rivalries and reputations over time.

## 5. Default game rules (all configurable)

- 9 players (you + 8 AI), 2 saboteurs
- Original map with ~10 rooms and connecting corridors
- 5 tasks each (3 short, 2 long); crew also wins when all tasks are done
- Kill cooldown 25 s; vision radius smaller for crew than saboteurs; lights sabotage shrinks it more
- 1 emergency meeting per player; 90 s discussion + 30 s voting; ejections confirm role (toggle)
- Sabotages: lights + one critical timed sabotage
- Vents for saboteurs (Phase 4)

## 6. Tech stack (recommended)

| Part | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language; shared types between client and server |
| Client | Phaser 3 + Vite, maps built in Tiled | Mature 2D engine, runs in the browser, no install |
| Server | Node.js + `ws` | Holds the game state; runs headless AI-only games for testing |
| LLM | LM Studio local server (default); Claude API via `@anthropic-ai/sdk` (optional) | Free local play on your GPU; Claude only for the optional Mastermind upgrade |
| Storage | SQLite (JSON files at first) | Persona memory, game history, replays |
| Tests | Vitest + a headless simulation runner | Run hundreds of AI-only games to tune the AI |
| Placeholder art | Kenney.nl (CC0) or simple shapes | Free, original, swap later |

The LLM gateway sits behind one interface, so each agent can point at LM Studio or Claude. Any
API key stays on the server, never in the browser.

## 7. Running the AI locally (LM Studio)

The AI runs on a local model served by LM Studio on the player's own GPU. Which model to use is a
local setting, not part of the repo: the game uses whichever model LM Studio has loaded, or one
named on the command line. Mid-size instruct models (roughly 8–14B, quantized) suit a consumer
GPU: small enough to leave room for context, big enough to bluff and stay in character. Models too
big for the GPU spill into system RAM and become too slow for live play, though they're fine for
offline jobs like drafting persona cards.

**Rules for local play:**
- **One main model, loaded once.** A consumer GPU usually can't hold two mid-size models at once,
  and swapping models mid-game takes seconds. All 8 agents share it; personas and tiers come from
  the prompt and the notebook.
- **Assume one call at a time.** A mid-size model on a consumer GPU should answer a short call in
  roughly 2–4 s (to be measured). That's ~15–25 calls a minute for the whole table, so:
  - one priority queue: meeting speech > urgent events (body found) > round plans > the rest
  - everyday tactics run in code (4.2), not the LLM
  - short replies (max ~2 sentences) and small prompts (~2–4K tokens; context set to 8K to save VRAM)
  - if your LM Studio version supports parallel requests, we turn that on for more headroom
- **Order prompts for reuse.** Shared parts first (rules, map, meeting chat so far), the agent's
  persona and private memory last. LM Studio can then reuse the shared start from the previous
  call, so each agent only has to process its own tail.
- **Guaranteed JSON.** LM Studio's structured output (JSON schema) forces every reply into the
  `thoughts` / `say` / `goal` shape, so a small model can't break the format.
- **Thinking mode costs time.** Off for most calls; on for Masterminds only when the queue has room.

**Meeting budget check:** 90 s of discussion at ~3 s per line ≈ 25–30 lines, enough for every agent
to speak about 3 times. Votes use a smaller call (~1–2 s each) during the 30 s vote.

**Model bake-off (Phase 2):** run the same AI-only game seeds with 2–3 candidate models and compare
speed, role leaks, staying in character, and how often the crew votes out the right player.

**Cost:** local play is free. The optional Claude upgrade (2 Masterminds per game, meeting talk
only, ~24 calls) would be roughly $0.30 (Sonnet 5.5) to $0.60 (Opus 5.5) per game at current
prices, and those calls also skip the local queue.

## 8. Roadmap

| Phase | What | Done when |
|---|---|---|
| 0. Decide & set up (**done**) | Settle the decisions below; repo, tooling, project skeleton | `npm test` runs (the dev server comes with the client in Phase 3) |
| 1. Headless engine (**done**) | Map, movement, roles, tasks, kills, bodies, reports, meetings, votes, win checks; simple scripted bots | 100 scripted games finish with valid results |
| 2. AI agents (text) | LM Studio connection + priority queue, perception filter, memory, notebook, tactics + meeting brain, persona cards, tiers, text spectator log, post-game reveal, model bake-off | AI-only games make sense; saboteurs win sometimes; smarter tiers win more; main model picked |
| 3. Playable client (**MVP**) | 2D map, movement, fog of war, tasks, kill/report/meeting buttons, meeting chat + voting UI | You can play a full game in the browser against 8 AIs |
| 4. Depth | Vents, cameras/admin map, more sabotages, memory between games, difficulty presets, lobby to pick the cast, persona editor | Replay value: the cast feels different game to game |
| 5. Polish | Art pass, sound, a text-to-speech voice per persona, optional voice input, replays | It feels like a finished game |

Building the headless engine and AI-only games first (Phases 1–2) is on purpose. It lets us tune
the AI quickly and cheaply before any graphics exist, and watching AIs play each other is fun.

## 9. Risks

| Risk | What we do about it |
|---|---|
| Slow meetings | Generate the next line while the current one shows, typing indicators, short replies |
| Local model too slow for 8 agents | Priority queue, code-driven tactics, small prompts ordered for reuse; parallel requests if supported |
| Small model plays badly (weak lies, forgets facts) | Notebook does the bookkeeping in code; bake-off picks the best model; optional Claude Masterminds |
| AI saboteurs give themselves away or break character | Separate `thoughts`/`say`, role-leak checker, persona voice rules |
| Engine leaks hidden info to AIs | Perception filter is the only input; automated leak test |
| One shared model makes everyone sound alike | Strong voice cards with sample lines, per-game mood, memory between games |
| Tiers don't feel different | Measure in AI-only batches; tune memory/perception handicaps |
| Masterminds are unbeatable | Difficulty presets; cap Masterminds per game |

## 10. Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Base | Mod Among Us / build from scratch | **Decided: build from scratch, original game** |
| 2 | Theme & name | Deep-sea research station / snowbound polar outpost / haunted manor dinner party / your own idea | Your call |
| 3 | Tech stack | TypeScript web (Phaser + Node) / Godot + AI sidecar / Python | TypeScript web |
| 4 | Visual style | Free-roam 2D top-down / room-to-room board / text only | 2D top-down (text-only sim first, for testing) |
| 5 | AI provider | Local (LM Studio) / Claude API / both | **Decided: local LM Studio**; Claude optional for Masterminds |
| 6 | Main local model | Any model that fits the GPU | Pick with the Phase 2 bake-off; kept as a local setting, not committed |
| 7 | Claude upgrade for Masterminds | Off / on (~$0.30–0.60 per game) | Off at first; try once local play works |
| 8 | Meeting input/output | Typed chat / + AI voices (TTS) / + your voice input | Typed chat first, voices in Phase 5 |
| 9 | Your role | Random / always crew / always saboteur / spectator mode | Random, plus spectator mode |
| 10 | Cast | Fixed hand-made cast / generated each game / your own editor | Hand-made cast of ~12, editor later |
| 11 | Memory between games | None / reputations and grudges | Yes, in Phase 4 |
| 12 | Tasks for you | Real mini-games / hold-to-complete | Hold-to-complete in MVP, mini-games later |
| 13 | Player count & rules | — | 9 players, 2 saboteurs, configurable |

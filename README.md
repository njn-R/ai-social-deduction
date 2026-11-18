# AI Social Deduction (working title)

A single-player social-deduction game where every other player is an AI with its own persona
and intelligence level. The full plan is in [PLAN.md](PLAN.md).

## Status

- **Phase 1 (done):** headless engine: rules, a placeholder map, scripted bots, a simulator.
- **Phase 2 (nearly done):** AI players running on a local model through LM Studio, with
  personas, tiers, memory, a code-kept notebook, meeting talk, votes and a post-game reveal.
  Still open: a bigger batch of games to show smarter tiers play better.
- No graphics yet.

## Commands

```bash
npm install
npm test                                 # all tests (no model needed)
npm run typecheck
```

Scripted bots (no model):

```bash
npm run sim                              # 20 bot-only games, prints stats
npm run sim -- --games 1 --log           # watch one game as a text log
```

AI players (needs LM Studio running with a model loaded: `lms server start`, then
`lms load <model> -c 16384`; the larger context leaves room when calls run in parallel):

```bash
npm run llm:check                        # is the model reachable, and how fast is it?
npm run ai                               # one AI-only game on the loaded model
npm run ai -- --thoughts                 # ...and print each AI's private thoughts as it plays
npm run ai -- --fake                     # dry run with canned replies, no model needed
npm run bakeoff -- --models <a>,<b> --seeds 1,2,3   # compare models on the same seeds
npm run ai:stats                         # compare every saved game, by model and by tier
```

Each AI game writes a reveal (`.md`, every private thought next to what was said) and raw data
(`.json`) to `runs/`, which is not committed. Which model you use is your local choice: pass
`--model <id>`, put `{ "model": "<id>" }` in `ai.local.json` (git-ignored), or the game uses
whatever LM Studio has loaded.

## Layout

```
src/engine/          rules and state, no I/O
  game.ts            the authoritative Game: setMove / act / observe / step
  observation.ts     what one player is allowed to know (bots and AIs see only this)
  map/               map format, nav grid (A* pathfinding, line of sight), placeholder map
src/bots/            Reflexes (walking, tasks, kill-and-run), Navigator, ScriptedBot
src/ai/              LLM players
  agent.ts           AiAgent: reflexes + memory + LLM plans, meeting lines and votes
  director.ts        runs the meeting conversation (who talks next, when votes are asked)
  memory.ts          what each AI noticed, shaped by its tier
  notebook.ts        code-kept notes: sightings, bodies, claims checked against sightings
  personas.ts        the cast of 12
  tiers.ts           rookie / average / sharp / mastermind
  prompts.ts, schemas.ts   prompt text and the JSON shapes replies must follow
  llm/               LM Studio client, fake model, and the priority queue with a virtual clock
src/sim/             headless runner, invariant checks, text log, CLI
test/                Vitest suites
```

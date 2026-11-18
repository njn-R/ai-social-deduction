# AI Social Deduction (working title)

A single-player social-deduction game where every other player is an AI with its own persona
and intelligence level. The full plan is in [PLAN.md](PLAN.md).

## Status

- **Phase 1 (done):** headless engine: rules, a placeholder map, scripted bots, a simulator.
- **Phase 2 (nearly done):** AI players running on a local model through LM Studio, with
  personas, tiers, memory, a code-kept notebook, meeting talk, votes and a post-game reveal.
  Still open: a bigger batch of games to show smarter tiers play better.
- **Phase 3 (playable):** play in your browser against 8 AIs.

## Play

Start LM Studio with a model loaded (`lms server start`, then `lms load <model> -c 16384`), then:

```bash
npm install
npm run play                             # builds the client, then serves http://localhost:8787
```

Open http://localhost:8787, pick a name and a role (or random), and press Start.

| Key | What it does |
|---|---|
| WASD / arrows | move |
| E | do the task you're standing at (saboteurs fake theirs) |
| R | report a body you're near |
| B | press the emergency button (in Commons) |
| Q | kill the crew member next to you (saboteurs, when the cooldown is ready) |

In meetings, type in the chat box and press Enter; when voting opens, click **Vote** next to a
player or **Skip vote**. The AIs leave time to read each line, wait while you're typing, and
answer what you actually said. When the game ends you get the full reveal: every AI's private
thoughts next to what it said.

**Voices:** tick "Read AI lines aloud" in the lobby (or use **Mute voices** in a meeting). Each AI
has its own voice and speaking speed, generated in your browser by
[Kokoro](https://npmjs.com/package/kokoro-js) on the CPU, so the GPU stays free for the
language model. The first time, the browser downloads the ~90 MB voice model and then caches it.

Without a model: `npm run play -- --fake` (canned AI lines, for trying the controls).

## Commands

```bash
npm install
npm test                                 # all tests (no model needed)
npm run typecheck                        # server and client
npm run server -- --fake                 # game server only (with `npm run dev:client` for live client reloads)
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
client/              the browser game (canvas map and fog of war, HTML HUD, meeting and reveal screens)
src/server/          game server: one live game, your seat plus 8 AI seats, over a WebSocket
src/shared/          messages between browser and server
src/engine/          rules and state, no I/O (also used by the browser for the map)
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

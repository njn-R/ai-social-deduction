# AI Social Deduction (working title)

A single-player social-deduction game where every other player is an AI with its own persona
and intelligence level. The full plan is in [PLAN.md](PLAN.md).

## Status

Phase 1 (headless engine) is done: rules, a placeholder map, scripted bots and a simulator.
No graphics and no LLM yet.

## Commands

```bash
npm install
npm test                                 # all tests, including a 100-game simulation check
npm run typecheck
npm run sim                              # 20 bot-only games, prints stats
npm run sim -- --games 1 --log           # watch one game as a text log
npm run sim -- --games 1 --log --tasks   # ...including task completions
npm run sim -- --games 100 --seed 7      # 100 games, seeds 7..106
```

## Layout

```
src/engine/          rules and state, no I/O
  game.ts            the authoritative Game: setMove / act / observe / step
  observation.ts     what one player is allowed to know (bots and AIs see only this)
  config.ts          rule settings (timers, ranges, task counts, ...)
  map/               map format, nav grid (A* pathfinding, line of sight), placeholder map
src/bots/            controllers: Navigator (walking) and ScriptedBot
src/sim/             headless runner, invariant checks, text log, CLI
test/                Vitest suites
```

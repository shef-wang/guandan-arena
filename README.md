# Guandan Arena

This project is ultimately about building superhuman AI for the game of Guandan.

The working thesis for this repo is:

1. To build very strong Guandan agents, we need a serious competitive arena.
2. To build that arena, we need a high-performance game engine, a usable GUI, reproducible evaluation, and support for modern models, especially open-weight/local models.
3. To get there in practice, we are building the system in layers, starting from a playable MVP and expanding toward multi-agent evaluation and learned policies.

This repository is under active development.

## Current Status

- A public MVP is live here: [guandan-arena-sigma.vercel.app](https://guandan-arena-sigma.vercel.app/)
- The live MVP is intentionally narrow:
  - single-player only
  - `1 human vs 3 built-in AI`
  - built-in rule-based `legacy-v1` opponents
- The broader arena, LLM competition flows, and learned-agent work are still in progress.

## Project Direction

The end state is not just a casual card game site.
The end state is a development and evaluation environment for strong Guandan agents.

That means this repo is being shaped around four pillars:

- `Game engine`
  - fast, deterministic Guandan rules and state transitions
  - stable legal-action generation
  - reproducible match execution
- `GUI / product surface`
  - a browser-based table for rapid iteration
  - human-playable interfaces for testing game feel and correctness
  - a path to deployable demos
- `Arena`
  - multi-agent match running
  - seeded evaluation and comparison
  - support for agent-vs-agent tournaments
- `Learning stack`
  - heuristic baselines
  - open-weight / local model integration
  - imitation learning and self-play reinforcement learning

## What Exists In The Repo Today

### 1. Core Guandan engine

The TypeScript game implementation is the foundation of the whole project.
It handles cards, rules, legal move generation, game state updates, and result resolution.

Key files:

- `src/game/rules.ts`
- `src/game/state.ts`
- `src/game/cards.ts`
- `src/game/types.ts`

### 2. Browser GUI

There is already a React/Vite frontend for interacting with the game in the browser.
The current public deployment uses this layer to ship the single-player MVP.

Key files:

- `src/App.tsx`
- `src/PracticeTable.tsx`
- `src/table/GameTableScene.tsx`
- `src/ui/tableWidgets.tsx`

### 3. Arena / agent infrastructure

The repo already contains arena-oriented code for running agent-controlled matches and experimenting with different decision systems.
This is part of the longer path toward a real model competition environment.

Key files:

- `src/arena/engine.ts`
- `src/arena/runBuiltinTournament.ts`
- `src/arena/openrouter.ts`
- `src/arena/runHeadlessMatch.ts`

### 4. Baseline and training work

The current built-in rule-based agents act as baselines.
Alongside that, the repo contains early training infrastructure for a DanZero-style path toward learned Guandan agents.

Key files and docs:

- `src/game/ai.ts`
- `docs/danzero-style-mvp-roadmap.md`
- `training/danzero_mvp/README.md`
- `training/danzero_mvp/train_imitation.py`
- `training/danzero_mvp/train_ppo.py`

## Why The MVP Looks Small

The current Vercel deployment is deliberately much smaller than the ambition of the repo.

That is by design.

The MVP is there to prove and polish the lowest layer:

- the game runs correctly in the browser
- the table UI is usable
- the engine can support a real playable product
- the baseline AI can drive a complete game loop

That playable slice is useful on its own, but it is also a stepping stone toward the larger arena and training system.

## Near-Term Path

The likely path forward is:

1. continue improving the engine and GUI until the single-player product feels solid
2. strengthen the arena and tournament harness for agent-vs-agent evaluation
3. integrate stronger model-based agents, especially local/open-weight ones
4. train and benchmark learned policies against the existing heuristic baselines
5. iterate toward agents that materially outperform the current handcrafted bots

## Running Locally

This repo currently ships a Vite frontend.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

## Repo Notes

- The live web app is only the current MVP, not the full vision of the repository.
- The repo contains experimental and in-progress components; expect active iteration.
- Documentation in `docs/` and `training/danzero_mvp/` is a better guide to the long-term direction than the current public demo alone.

# Qwen 7B Reranker Training Plan

## Purpose

This document is a handoff plan for another coding agent running on a local Mac mini.

The goal is **not** to train a full Guandan policy from scratch.
The goal is to train a **Qwen 7B reranker** that sits on top of the existing `legacy-v1` heuristic:

1. `legacy-v1` proposes a small shortlist of legal candidate actions
2. Qwen 7B chooses among those candidates
3. PPO fine-tunes the model to improve team outcomes over `legacy-v1`

This is the most realistic path for local Apple Silicon training.

## Problem Framing

Guandan is a 4-player partnership card game played with two decks.

In this repo:

- seats `0` and `2` are teammates
- seats `1` and `3` are teammates
- the current implementation uses a fixed trump setup:
  - trump rank = `A`
  - wild card = `hearts-A`
- terminal reward depends on **team finishing order**, not just who goes out first

That last point matters.
A player can finish first and the game can still continue because the remaining finishing order affects the final level gain or loss.

From the team perspective, final outcomes are:

- `12` -> win `+3`
- `13` -> win `+2`
- `14` -> win `+1`
- `23` -> lose `-1`
- `24` -> lose `-2`
- `34` -> lose `-3`

This makes Guandan a poor fit for naive one-step tactical imitation alone.
Good play depends on:

- preserving hand structure
- helping partner timing
- deciding when to pass
- deciding when to spend bombs and high-control responses

## Why Train A Reranker Instead Of A Full Agent

Do **not** start by training Qwen 7B to generate arbitrary legal actions from raw state.

Reasons:

- the legal action space is large and state-dependent
- combinatorial move generation is already solved in the TypeScript engine
- PPO over full action generation is much higher variance
- on a Mac mini, full-policy RL at 7B scale is too expensive for MVP

Instead, train a reranker with this action space:

- input: state + `legacy-v1` top-K candidates
- output: candidate index `0..K-1`

This keeps:

- legal action generation symbolic and exact
- action space small and stable
- PPO much easier
- benchmark interpretation much cleaner

## Current Codebase Map

These files matter most.

### Core Game Logic

- [src/game/rules.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/rules.ts)
  Legal move generation, move filtering, play comparison.

- [src/game/state.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/state.ts)
  Game transitions, pass/play application, terminal result resolution.

- [src/game/types.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/types.ts)
  Shared game types.

- [src/game/cards.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/cards.ts)
  Deck creation, shuffle, seeded randomness.

### Heuristic Policies

- [src/game/ai.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/ai.ts)
  Current built-in policies:
  - `baseline`
  - `legacy-v1`
  - `legacy-vR`
  - `balanced-v2`

Important exported functions:

- `chooseAiAction(...)`
- `rankLegacyV1ActionCandidates(...)`

`rankLegacyV1ActionCandidates(...)` is especially important because it already exposes the candidate ranking logic needed for a reranker policy.

### Arena / Prompt / Benchmarking

- [src/arena/engine.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/engine.ts)
  Arena match runner, legal action packaging, agent abstraction.

- [src/arena/types.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/types.ts)
  Arena-facing observation and action types.

- [src/arena/prompt.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/prompt.ts)
  Current LLM prompt formatting for arena decisions.

- [src/arena/openrouter.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/openrouter.ts)
  Current `openrouter` and `llmreranker` logic.

- [src/arena/deviationMetric.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/deviationMetric.ts)
  Formal metric for how often a reranker deviates from `legacy-v1`.

- [src/arena/runHeadlessMatch.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/runHeadlessMatch.ts)
  Headless benchmark runner, now already emits `deviation_metric` for `llmreranker`.

### Existing Training Stack

- [training/danzero_mvp/README.md](/Users/sheffieldwang/Documents/codexexp/guandan/training/danzero_mvp/README.md)
- [training/danzero_mvp/export_imitation_dataset.ts](/Users/sheffieldwang/Documents/codexexp/guandan/training/danzero_mvp/export_imitation_dataset.ts)
- [training/danzero_mvp/export_selfplay_ppo_dataset.ts](/Users/sheffieldwang/Documents/codexexp/guandan/training/danzero_mvp/export_selfplay_ppo_dataset.ts)
- [training/danzero_mvp/train_imitation.py](/Users/sheffieldwang/Documents/codexexp/guandan/training/danzero_mvp/train_imitation.py)
- [training/danzero_mvp/train_ppo.py](/Users/sheffieldwang/Documents/codexexp/guandan/training/danzero_mvp/train_ppo.py)

These are useful references, but the Qwen reranker path should be treated as a separate training line, not a small tweak on the existing lightweight MLP baseline.

## How `legacy-v1` Works Today

`legacy-v1` is a handcrafted reranker over legal actions.

At a high level:

1. enumerate all legal plays
2. score each play
3. score `pass` where applicable
4. choose according to a rule-aware decision policy

Important nuance:

- `rankLegacyV1ActionCandidates(...)` returns candidates sorted by score
- `chooseLegacyV1AiAction(...)` does **not** always pick raw rank `#1`
- it still applies pass-vs-ordinary-vs-special thresholds

So there are two different notions:

- `legacy top-1 candidate`
- `legacy fallback action`

This distinction is already reflected by `deviation_metric` and should remain explicit in all training/evaluation pipelines.

### What The `legacyScore` Means

The score is not a simple "bigger card is better" number.
It mainly reflects:

- quality of the **remaining hand shape** after the move
- estimated ability to finish efficiently
- bomb preservation / bomb consumption
- tactical response value
- pass value in team context

So for the reranker, `legacyScore` is a useful feature, but it is a black-box summary of several heuristic judgments.

## Current `llmreranker`

The existing `llmreranker` in [src/arena/openrouter.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/openrouter.ts) already has the right conceptual structure:

- build `legacy-v1` top-K candidates
- include `legacyScore`
- mark the `legacy fallback`
- ask a model to choose one candidate only

This is the exact product behavior we want to replace with a local learned reranker.

## Target System

Train a local Qwen 7B reranker with:

- base model: `Qwen 7B Instruct`
- tuning method: `LoRA` or `QLoRA`
- task: choose one candidate index from `legacy-v1` top-K
- final runtime: local inference on Mac mini

The trained model should replace or augment the current OpenRouter reranker path.

## Recommended Training Objective

Do **not** train free-form text generation as the core policy target.

Train a constrained candidate selector:

- input = structured state + candidate list
- output = one discrete action token representing candidate index

Recommended target format:

- `<choice_0>`
- `<choice_1>`
- `<choice_2>`

Start with `K=3`.

Why:

- lower latency
- less prompt waste
- smaller action space
- easier PPO updates
- easier debugging

## Observation / Prompt Design

Keep the observation compact and structured.

Do not dump the entire current verbose arena prompt into the model unless needed.

Recommended input sections:

### Header

- acting seat
- acting team
- teammate seat
- opponent seats
- current turn index

### Public State

- current table play summary
- finish order so far
- remaining hand counts for all seats
- recent public actions

### Private State

- own hand summary
- own exact cards

### Candidate Block

For each candidate in `legacy-v1` top-K:

- candidate index
- whether it is the `legacy fallback`
- `legacyRank`
- `legacyScore`
- action id
- play type
- size
- primary value
- bomb size
- wild count
- cards

### Output Constraint

Tell the model to emit exactly one of:

- `<choice_0>`
- `<choice_1>`
- `<choice_2>`

The decoding layer should map the chosen token back to a candidate index.

## Data Plan

Use three data sources.

### 1. Imitation Seed Data

Generate reranker training rows from `legacy-v1` itself.

Each row should include:

- state features / prompt
- top-K candidate list
- `legacy fallback`
- chosen candidate index
- final match outcome

This gives a stable warm start.

### 2. Distilled Preference Data

If available, use:

- current `llmreranker` trajectories
- manually reviewed interesting decisions
- hard positions where alternative candidates outperform fallback

This is optional for MVP but high leverage.

### 3. PPO Rollout Data

Once imitation is stable, generate on-policy rollouts where:

- Qwen reranker controls one team
- opponent team uses `legacy-v1`
- optionally teammate remains `legacy-v1` in early stages

## Training Phases

## Phase 0: Infrastructure

Deliverables:

- a reranker dataset exporter in TypeScript
- a prompt/feature encoder for Qwen reranker training
- a local evaluation harness for `Qwen reranker vs legacy-v1`

Suggested new folder:

- `training/qwen_reranker/`

Suggested files:

- `README.md`
- `export_reranker_imitation_dataset.ts`
- `export_reranker_ppo_rollouts.ts`
- `prompt_builder.py` or TS equivalent if prompts are rendered on the TS side
- `train_sft.py`
- `train_ppo.py`
- `serve_qwen_reranker.py`
- `evaluate_reranker.ts`

## Phase 1: Supervised Warm Start

Train Qwen 7B with LoRA to imitate `legacy-v1` candidate choices.

Goal:

- stable candidate-index output
- near-perfect legality
- good match with fallback on easy cases

Success criteria:

- valid candidate token output rate is high
- on a held-out set, top-1 imitation accuracy is acceptable
- local inference works on Mac mini

Important:

- this phase is not supposed to beat `legacy-v1`
- it is supposed to make PPO stable later

## Phase 2: PPO Fine-Tuning

Only after supervised warm start.

Environment:

- `legacy-v1` proposes top-K
- Qwen reranker selects candidate index
- engine executes that exact move

Reward:

- primary reward = signed final level delta
  - `+3, +2, +1, -1, -2, -3`

Optional shaped reward later:

- small bonus for preserving partner advantage
- small penalty for catastrophic bomb misuse

But for MVP, sparse final reward is cleaner.

Policy/value setup:

- policy head predicts candidate index
- value head predicts expected signed final level delta

Suggested early curriculum:

1. single-team PPO vs `legacy-v1`
2. fixed teammate = `legacy-v1`
3. only later introduce self-play / checkpoint opponents

## Phase 3: Hard-Case Training

After baseline PPO is stable, bias training toward cases where reranking matters:

- small score gap between candidate `#1` and `#2`
- bomb usage decisions
- pass vs play decisions
- endgames
- partner-support situations

This matters because many turns are trivial and should be skipped or kept as fallback.

## Evaluation Plan

All evaluations should be seeded and reproducible.

Minimum metrics:

- win rate vs `legacy-v1`
- average signed level delta
- inference validity rate
- average latency per reranked turn
- request-free local runtime stability
- `deviation_metric`

For `deviation_metric`, always track:

- `deviationRateFromLegacyTop`
- `deviationRateFromLegacyFallback`
- `averageChosenLegacyRank`
- `averageFallbackLegacyRank`
- sample deviations

Interpretation rule:

- more deviation is **not** automatically better
- useful deviation means deviation that improves team outcomes

## Mac Mini Constraints

Assume:

- local Apple Silicon
- limited RAM compared to a multi-GPU Linux box
- no distributed actor farm

Design implications:

- use LoRA / QLoRA, not full fine-tune
- keep sequence length tight
- keep `K=3` initially
- keep prompt structured and compact
- prefer offline batch rollouts plus periodic updates
- expect slower training but manageable iteration

The key local goal is:

- make a 7B reranker that improves some meaningful subset of decisions

Not:

- reproduce a giant distributed RL pipeline

## Implementation Priorities For The Next Coding Agent

### Priority 1

Create `training/qwen_reranker/README.md` and initial file skeleton.

### Priority 2

Implement a TypeScript exporter that emits reranker imitation rows from the existing engine.

Each row should contain:

- seed
- seat
- turn
- compact state serialization
- top-K candidate block
- fallback index
- chosen index
- final signed reward

### Priority 3

Implement Qwen SFT training with LoRA on candidate-index outputs.

### Priority 4

Implement a local inference bridge so the trained model can act inside the current arena.

### Priority 5

Implement PPO fine-tuning on top of the warm-start checkpoint.

## Suggested MVP Success Bar

The first success criterion should be modest:

- the trained reranker runs locally
- it produces valid candidate selections
- it has non-trivial `deviation_metric`
- it is not obviously worse than `legacy-v1`

The second success criterion:

- beat `legacy-v1` on a fixed seeded benchmark

Only after that should the agent move on to:

- larger prompt context
- mixed opponent pools
- self-play leagues
- partner-style specialization

## Final Recommendation

Treat this project as:

- **symbolic proposal policy** from `legacy-v1`
- **learned reranking policy** from Qwen 7B
- **PPO fine-tuning** over a tiny action space

That is the path most likely to work on a local Mac mini while still giving a real chance to outperform the current heuristic.

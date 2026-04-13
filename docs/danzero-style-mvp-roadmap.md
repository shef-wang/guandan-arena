# DanZero-Style Agent MVP Roadmap

## Goal

Build a DanZero-style Guandan agent for this repo without trying to clone the original research stack exactly.

For this project, "DanZero-style" means:

- self-play reinforcement learning instead of pure heuristics
- a neural policy that scores legal actions dynamically
- a value head that estimates final team outcome
- fixed-seed evaluation against `legacy-v1` and `balanced-v2`
- a local inference bridge so the trained model can run inside the current arena UI

The MVP goal is not "match the paper". The MVP goal is:

- beat `legacy-v1` on a fixed evaluation suite
- integrate into `4AI` mode as one more seat type
- keep the training stack understandable and reproducible

## Recommendation

Do **not** try to reproduce original DanZero / DanZero+ literally.

Instead:

1. Keep the current game engine and rule implementation in TypeScript as the source of truth.
2. Build a small Python training stack around exported self-play data or a thin environment wrapper.
3. Use a modern PyTorch policy-value model with legal-action masking.
4. Warm-start from imitation of our current heuristics, then continue with self-play RL.

This is the fastest path that still preserves the key DanZero idea: learn from self-play over a dynamic legal action space.

## What We Can Reuse

These files already give us most of the environment logic:

- [src/game/rules.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/rules.ts): legal move generation and comparison
- [src/game/state.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/state.ts): state transitions and terminal resolution
- [src/arena/engine.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/engine.ts): match runner and legal action packaging
- [src/game/ai.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/ai.ts): current heuristic baselines
- [src/arena/runBuiltinTournament.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/runBuiltinTournament.ts): reproducible seeded evaluation harness

Recent additions already help:

- seeded shuffle/random in [src/game/cards.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/cards.ts:56)
- deterministic `createNewGame(random)` in [src/game/state.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/game/state.ts:13)
- seeded tournament runner in [src/arena/runBuiltinTournament.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/runBuiltinTournament.ts:18)

That means we do **not** need to rebuild Guandan rules from scratch for MVP.

## Non-Goals For MVP

Avoid these until the first learned agent is working:

- reproducing the original paper's exact distributed actor-learner topology
- reproducing TensorFlow 1.x codepaths
- training from raw card tokens if a simpler feature encoder works
- solving imperfect-information RL in a theoretically complete way
- adding MCTS before a plain policy-value self-play baseline exists

## MVP Architecture

### 1. Environment Layer

We need a training environment with two capabilities:

- return the acting player's observation
- enumerate legal actions in a stable indexed format

Recommended shape:

- keep the game transition logic in TypeScript
- export one step API that receives `state + actionId` and returns `nextState`
- export one observation builder for the current player only

There are two implementation options:

- Preferred MVP: build a small Node service or CLI bridge around the existing TS engine
- Later optimization: reimplement the environment in Python after the observation/action format is frozen

Why:

- TS rules are already correct enough for training experiments
- the risk of rule drift is much higher than the cost of a thin bridge

### 2. Observation Design

Do not feed full hidden information to the acting policy.

Use only:

- own hand
- public hand counts of all players
- current table play
- round trace / last actions
- finish order
- seat id and teammate/opponent relation
- legal action list

A practical observation format:

- state tensor:
  - own hand rank histogram
  - own hand suit/wild/joker counts
  - current table play type, size, primary value, bomb size, wild count
  - remaining hand counts for 4 seats
  - current player seat
  - table owner seat or none
  - finish flags / finish positions
  - pass flags / round state
- action tensor per legal action:
  - play type
  - cards used
  - primary value
  - bomb size
  - wild count
  - whether this is pass
  - post-action hand-count delta

This naturally supports a legal-action scoring model:

- encode state once
- encode each legal action
- score each legal action conditioned on the state

### 3. Model Design

Use a policy-value network:

- shared state encoder
- action encoder for each legal action
- policy head: score each legal action, softmax over legal actions only
- value head: predict expected final team result

Recommended MVP target:

- value target = final level delta from the acting player's team perspective
  - win 3 -> `+3`
  - win 2 -> `+2`
  - win 1 -> `+1`
  - lose 1 -> `-1`
  - lose 2 -> `-2`
  - lose 3 -> `-3`

Recommended stack:

- Python 3.11+
- PyTorch
- simple MLP or transformer-lite encoder

Do not over-design the first model. A compact MLP over structured features is enough for MVP.

## Training Plan

### Phase 0: Reproducible Evaluation

Before training, create a fixed benchmark suite.

Deliverables:

- `eval_seeds_train.txt`
- `eval_seeds_dev.txt`
- `eval_seeds_test.txt`
- a runner that evaluates learned agent vs `legacy-v1` and `balanced-v2`

Success criteria:

- same seed set always gives identical results
- seat order alternates by match
- output includes win rate and average level delta

We already have the foundation in [src/arena/runBuiltinTournament.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/runBuiltinTournament.ts:18).

### Phase 1: Imitation Warm Start

Do this first. Starting RL from scratch will be much slower and noisier.

Data generation:

- run `legacy-v1` self-play and `balanced-v2` self-play
- record `(observation, legal actions, chosen action, final outcome)`
- generate at least hundreds of thousands of decision points

Targets:

- policy target: chosen heuristic action
- value target: final team level delta

Why this matters:

- the model learns legal action ranking quickly
- PPO/self-play later becomes much more stable

Success gate:

- top-1 action match against heuristic target is reasonable
- trained model can finish games legally without crashing

### Phase 2: Self-Play RL MVP

After imitation, switch to self-play.

Recommended algorithm:

- PPO first

Not recommended for MVP:

- reproducing DMC exactly
- building a huge distributed prioritized replay system before proving signal exists

PPO rollout loop:

1. Sample a seeded initial game.
2. Let 4 copies of the current policy play the game.
3. Store per-turn observation, legal actions, chosen action, logprob, value, reward.
4. At terminal, assign final team level delta back through the trajectory.
5. Update policy and value.

Practical stabilizers:

- self-play against a mixture of opponents:
  - latest policy
  - previous policy snapshots
  - `legacy-v1`
  - current `balanced-v2`
- keep action masking strict
- clip gradients
- cap game length

Success gate:

- on dev seeds, learned model is at least not worse than `legacy-v1`
- training curves stop collapsing into illegal/degenerate play

### Phase 3: Population / League Training

This is the first upgrade after the MVP works.

Add:

- opponent pool with historical checkpoints
- arena-style evaluation ladder
- checkpoint promotion based on seeded tournaments

Why:

- reduces overfitting to one snapshot of self-play
- more closely matches the spirit of DanZero-style population improvement

### Phase 4: Arena Integration

Once a checkpoint is good enough, integrate it into the current app.

Best integration path:

- keep training/inference in Python
- add a local inference server or subprocess agent
- create a TS bridge agent similar in spirit to [src/arena/openrouter.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/openrouter.ts)
- register it through `createFunctionAgent` or a dedicated bridge in [src/arena/engine.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/engine.ts:43)

MVP runtime shape:

- TS side sends current-player observation + legal actions
- Python side returns chosen legal action id
- TS side applies action with the existing engine

## Suggested Repo Additions

For a clean MVP, add something like:

```text
training/
  danzero_mvp/
    README.md
    requirements.txt
    env_bridge/
    feature_encoder/
    models/
    imitation/
    ppo/
    eval/
    checkpoints/
```

And on the TS side:

```text
src/arena/pythonAgent.ts
src/arena/runLearnedTournament.ts
```

## Evaluation Standard

Use fixed-seed evaluation as the primary truth source.

Track:

- win rate
- average level delta
- first-out rate
- last-out rate
- average game length
- action distribution:
  - pass rate
  - bomb rate
  - straight-flush rate

Recommended gates:

- Gate A: model plays legal full games reliably
- Gate B: model >= `legacy-v1` on dev seeds
- Gate C: model > `legacy-v1` by a meaningful margin on held-out test seeds
- Gate D: model is stable across at least 2 seed batches, not just one lucky batch

## Minimum Timeline

For one focused engineer, realistic MVP timing is roughly:

1. 2-4 days: environment bridge + dataset export + fixed seeded evaluation
2. 3-5 days: imitation baseline
3. 5-10 days: PPO self-play MVP
4. 2-3 days: arena inference bridge and app integration

Total:

- optimistic: about 2 weeks
- more realistic: 3-4 weeks

## Biggest Risks

### Risk 1: Observation mismatch

If the model accidentally sees hidden opponent information during training but not at inference, results will be fake.

Mitigation:

- freeze a strict acting-player observation schema early
- unit test it

### Risk 2: Dynamic action space instability

If legal-action indexing is inconsistent, training becomes noisy or broken.

Mitigation:

- always rank the provided legal actions, never learn over a giant global action id table first

### Risk 3: RL noise hides whether the model improved

This already happened with our heuristic experiments before seeded evaluation.

Mitigation:

- fixed-seed dev/test suites
- compare against frozen baselines
- do not trust one random tournament batch

### Risk 4: Overfitting to self-play quirks

Mitigation:

- play against checkpoint pools and heuristic opponents
- hold out baseline-vs-model test suites

## Strong Recommendation For The First Version

If we want the shortest path to a useful learned agent, do this exact sequence:

1. Freeze a current-player-only observation schema.
2. Export self-play imitation data from `legacy-v1` and `balanced-v2`.
3. Train a legal-action scoring policy-value model in PyTorch.
4. Verify it can match heuristics and finish games legally.
5. Continue training with PPO self-play.
6. Evaluate only on fixed seeded tournaments.
7. Ship the first checkpoint as a local Python bridge agent in `4AI`.

This gives us a credible DanZero-style MVP without taking on the full research reproduction burden.

## Definition Of Done

We can call MVP complete when all of these are true:

- a learned model checkpoint exists locally
- it can play end-to-end inside the current arena
- it is reproducibly evaluated on fixed seeds
- it is at least competitive with `legacy-v1`
- the training and evaluation steps are documented well enough to rerun

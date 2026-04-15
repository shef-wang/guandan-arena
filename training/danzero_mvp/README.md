# DanZero-Style MVP On Apple Silicon

This directory is a practical Apple-Silicon-friendly prototype path for a DanZero-style Guandan agent.

It intentionally does **not** try to run the original DanZero+ codebase unchanged.

Why:

- the public `Danzero_plus` repository targets a mixed Linux stack with Python 3.8/3.6, TensorFlow 1.15.x, Docker actor/learner communication, and separate learner/actor codepaths
- this repo already has a stable TypeScript game engine and seeded evaluation harness
- for M-series Macs, a modern PyTorch + MPS implementation is a much better fit

The goal of this folder is to prove three things:

1. we can run a policy-value network on Apple Silicon via `mps`
2. we can model Guandan as `state_features + legal_action_features + legal_mask`
3. we can train a first policy head/value head prototype locally before wiring in real self-play data

## Files

- `requirements.txt`
- `policy_value_net.py`
- `smoke_train.py`
- `export_selfplay_ppo_dataset.ts`
- `train_ppo.py`

## Suggested Setup

```bash
cd /Users/sheffieldwang/Documents/codexexp/guandan
python3.11 -m venv .venv-danzero
source .venv-danzero/bin/activate
pip install -r training/danzero_mvp/requirements.txt
python training/danzero_mvp/smoke_train.py
```

## What This Prototype Does

The prototype uses:

- one state encoder MLP
- one per-action encoder MLP
- masked policy logits over legal actions only
- one scalar value head

That matches the most important structural idea we want from a DanZero-style implementation:

- do not classify over one giant global action table first
- instead, score only the legal actions available in the current state

## Next Steps After Smoke Test

1. replace synthetic features with real Guandan observation/action encoders
2. export supervised imitation data from `legacy-v1` / `balanced-v2`
3. train policy/value imitation baseline
4. add PPO self-play on top

## Why This Is Better For M Chips

The original public DanZero+ stack is research-oriented and tightly coupled to its older runtime choices.
For Apple Silicon, the practical route is:

- PyTorch
- `mps`
- compact structured features
- local single-process or light multi-process training first

Once the model is competitive, we can bridge inference back into the TypeScript arena.

## Self-Play PPO Loop

The first practical RL loop in this repo is:

1. start from an imitation checkpoint
2. export sampled self-play trajectories into JSONL
3. run PPO updates against those frozen rollout log-probabilities
4. evaluate new checkpoints against `legacy-v1`

Example flow:

```bash
./node_modules/.bin/esbuild training/danzero_mvp/export_selfplay_ppo_dataset.ts --bundle --platform=node --format=esm --outfile=/tmp/export_selfplay_ppo_dataset.mjs

CHECKPOINT=training/danzero_mvp/checkpoints/legacy_imitation_full_run1/epoch_006.pt \
MATCHES=64 \
PYTHON_BIN=.venv-danzero/bin/python \
OUTPUT_PATH=training/danzero_mvp/data/selfplay_rollout_run1.jsonl \
node /tmp/export_selfplay_ppo_dataset.mjs

.venv-danzero/bin/python training/danzero_mvp/train_ppo.py \
  --rollout training/danzero_mvp/data/selfplay_rollout_run1.jsonl \
  --init-checkpoint training/danzero_mvp/checkpoints/legacy_imitation_full_run1/epoch_006.pt \
  --output-dir training/danzero_mvp/checkpoints/ppo_run1 \
  --epochs 4 \
  --batch-size 256
```

Both the PPO trainer and the policy server support headroom controls:

- `--cpu-fraction 0.8`
- `--mps-memory-fraction 0.8`

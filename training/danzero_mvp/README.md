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

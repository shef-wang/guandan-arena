# ScoreNet Training Pipeline

This directory contains an attention-based training pipeline for Guandan:

- `legacy-v1` heuristic as baseline signal
- learned policy/value model (`ScoreNet`)
- imitation warm start
- PPO self-play where learned team (seats 0/2) plays vs `legacy-v1` team (seats 1/3)

## Files

- `feature_codec.ts`: state/action encoding with heuristic-augmented action features
- `scorenet.py`: attention policy-value network
- `serve_policy.py`: stdin/stdout inference server for TS runners
- `export_imitation_dataset.ts`: export legacy-v1 demonstration data
- `train_imitation.py`: supervised warm-start training
- `export_ppo_rollouts.ts`: generate PPO rollouts with GAE
- `train_ppo.py`: PPO update step
- `evaluate.ts`: learned vs legacy evaluation
- `selfplay_loop.sh`: end-to-end orchestration

## Prerequisites

From repo root:

```bash
python3 -m venv .venv-danzero
.venv-danzero/bin/pip install -r training/scorenet/requirements.txt
```

Node/esbuild must already be available (project already uses them).

## Quick Smoke Test

Run a tiny end-to-end check:

```bash
npx esbuild training/scorenet/export_imitation_dataset.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_imitation.cjs
npx esbuild training/scorenet/export_ppo_rollouts.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_ppo.cjs
npx esbuild training/scorenet/evaluate.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_eval.cjs

MATCHES=4 TRAIN_OUTPUT_PATH=training/scorenet/data/smoke_imitation_train.jsonl VALID_OUTPUT_PATH=training/scorenet/data/smoke_imitation_valid.jsonl node /tmp/scorenet_imitation.cjs
.venv-danzero/bin/python training/scorenet/train_imitation.py --train training/scorenet/data/smoke_imitation_train.jsonl --valid training/scorenet/data/smoke_imitation_valid.jsonl --output-dir training/scorenet/checkpoints/smoke_imitation --epochs 1 --batch-size 16
CHECKPOINT=training/scorenet/checkpoints/smoke_imitation/epoch_001.pt MATCHES=4 OUTPUT_PATH=training/scorenet/data/smoke_ppo_rollout.jsonl PYTHON_BIN=.venv-danzero/bin/python node /tmp/scorenet_ppo.cjs
.venv-danzero/bin/python training/scorenet/train_ppo.py --rollout training/scorenet/data/smoke_ppo_rollout.jsonl --init-checkpoint training/scorenet/checkpoints/smoke_imitation/epoch_001.pt --output-dir training/scorenet/checkpoints/smoke_ppo --epochs 1 --batch-size 16
CHECKPOINT=training/scorenet/checkpoints/smoke_ppo/epoch_001.pt MATCHES=4 PYTHON_BIN=.venv-danzero/bin/python node /tmp/scorenet_eval.cjs
```

## Standard Training Flow

### Option A: One-command loop (recommended)

```bash
training/scorenet/selfplay_loop.sh
```

Useful overrides:

```bash
PYTHON_BIN=.venv-danzero/bin/python \
ITERATIONS=50 \
ROLLOUT_MATCHES=200 \
EVAL_MATCHES=100 \
PPO_EPOCHS=4 \
TRAIN_EPOCHS=8 \
training/scorenet/selfplay_loop.sh
```

If you already have a warm-start checkpoint:

```bash
INIT_CHECKPOINT=training/scorenet/checkpoints/imitation_run_xxx/epoch_008.pt training/scorenet/selfplay_loop.sh
```

### Option B: Step-by-step manual

1) Export imitation data:

```bash
npx esbuild training/scorenet/export_imitation_dataset.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_imitation.cjs
MATCHES=5000 TRAIN_OUTPUT_PATH=training/scorenet/data/imitation_train.jsonl VALID_OUTPUT_PATH=training/scorenet/data/imitation_valid.jsonl node /tmp/scorenet_imitation.cjs
```

2) Train imitation checkpoint:

```bash
.venv-danzero/bin/python training/scorenet/train_imitation.py --train training/scorenet/data/imitation_train.jsonl --valid training/scorenet/data/imitation_valid.jsonl --output-dir training/scorenet/checkpoints/imitation_run_001 --epochs 8 --batch-size 128
```

3) Export PPO rollouts:

```bash
npx esbuild training/scorenet/export_ppo_rollouts.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_ppo.cjs
CHECKPOINT=training/scorenet/checkpoints/imitation_run_001/epoch_008.pt MATCHES=200 OUTPUT_PATH=training/scorenet/data/ppo_rollout.jsonl PYTHON_BIN=.venv-danzero/bin/python node /tmp/scorenet_ppo.cjs
```

4) PPO update:

```bash
.venv-danzero/bin/python training/scorenet/train_ppo.py --rollout training/scorenet/data/ppo_rollout.jsonl --init-checkpoint training/scorenet/checkpoints/imitation_run_001/epoch_008.pt --output-dir training/scorenet/checkpoints/ppo_run_001 --epochs 4 --batch-size 128
```

5) Evaluate:

```bash
npx esbuild training/scorenet/evaluate.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_eval.cjs
CHECKPOINT=training/scorenet/checkpoints/ppo_run_001/epoch_004.pt MATCHES=100 PYTHON_BIN=.venv-danzero/bin/python node /tmp/scorenet_eval.cjs
```

## Expected Outputs

- Imitation data:
  - `training/scorenet/data/imitation_train.jsonl`
  - `training/scorenet/data/imitation_valid.jsonl`
- PPO rollouts:
  - `training/scorenet/data/*.jsonl`
- Checkpoints:
  - `training/scorenet/checkpoints/**/epoch_XXX.pt`
  - `training/scorenet/checkpoints/**/history.json`
- Eval summaries:
  - JSON printed to stdout (and saved by `selfplay_loop.sh` per iteration)

## Data Format

Imitation sample:

```json
{
  "state_features": [0.0],
  "action_features": [[0.0]],
  "target_action_index": 0,
  "target_value": 1
}
```

PPO sample:

```json
{
  "state_features": [0.0],
  "action_features": [[0.0]],
  "chosen_action_index": 0,
  "old_log_prob": -0.5,
  "old_value": 0.1,
  "target_return": 1.0,
  "advantage": 0.9,
  "entropy": 0.4
}
```

## Troubleshooting

- `No samples found in ...`
  - Check previous export step output path and file size.
- Python import errors
  - Ensure you are using `.venv-danzero/bin/python` and installed requirements.
- Slow runs
  - Reduce `MATCHES`, `ITERATIONS`, and `EVAL_MATCHES` first.
- Policy server JSON parse errors
  - Rebuild latest bundles; stale `/tmp/*.cjs` files can mismatch current Python code.

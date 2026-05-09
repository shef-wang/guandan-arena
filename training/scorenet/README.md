# ScoreNet Training Pipeline

This directory contains an attention-based PPO training pipeline for the
2v2 trick-taking card game Guandan. The end product is a single neural
policy/value network that beats hand-crafted heuristic bots and continues
to improve via self-play.

Stack:

- A small attention network (`ScoreNet`): state/action encoders + a
  Transformer encoder + policy and value heads.
- An imitation warm start from the `legacy-v1` heuristic.
- PPO with GAE, with the learner controlling team-0 seats (0 and 2) by
  default. Opponents are heuristic bots, frozen older ScoreNet
  checkpoints, or a mix.
- A **two-step** PPO curriculum: `legacy-v2.6` **then** `legacy-v3.0` (there is
  **no** separate training milestone against `legacy-v2.7`). After that,
  self-play vs a frozen ScoreNet pool, and a final **gauntlet** (eval-only)
  that may include extra baselines such as `legacy-v2.7` for reporting.

## Files

Core training stack:

- `feature_codec.ts`: state/action encoding with heuristic-augmented action features
- `scorenet.py`: attention policy-value network
- `codec_config.py` + `codec_constants.json`: shared encoding constants for Python
- `runtime_utils.py`: device picker, seed helpers used across the Python scripts
- `serve_policy.py`: stdin/stdout inference server for TS runners
- `export_imitation_dataset.ts`: export legacy-v1 demonstration data
- `train_imitation.py`: supervised warm-start training
- `export_ppo_rollouts.ts`: generate PPO rollouts with GAE
- `train_ppo.py`: PPO update step
- `evaluate.ts`: learned vs legacy evaluation (with duplicate dealing)
- `bench_move_latency.ts`: per-move latency micro-benchmark for the policy server

Orchestration scripts:

- `selfplay_loop.sh`: end-to-end orchestration of one milestone (one of the
  curriculum stages or self-play, depending on env). All other shell scripts
  call into this.
- `run_curriculum.sh`: drives the **two-step PPO curriculum** (legacy-v2.6
  then legacy-v3.0) as a single command, snapshotting milestone winners.
- `run_selfplay.sh`: wrapper that launches `selfplay_loop.sh` in self-play
  mode against a frozen checkpoint pool (post-curriculum stage).
- `init_prior_manifest.sh`: bootstrap the frozen-pool manifest used by the
  self-play regimes from a directory of milestone checkpoints.
- `run_gauntlet.sh` + `aggregate_gauntlet.py`: final benchmark gauntlet vs
  every heuristic version.

Reference docs and bundled artifacts:

- `TRAINING_HISTORY.md`: chronological log of milestones, what worked, and
  what was retired. Useful when picking PPO hyperparameters or comparing
  checkpoints.
- `checkpoints/stability_v3_20260503_180902/ppo_iter_080/ppo/epoch_010.pt`:
  the production ScoreNet checkpoint that ships with the repo. This is the
  weights file used by `serve_policy.py` and the Practice / Spectator UIs
  (`scorenet-ppo` mode). Everything else under `checkpoints/` is gitignored.

## Who is the learner?

By default both team-0 seats (0 and 2) are controlled by the learner with
**shared parameters** (a single `ScoreNet`). Both seats' transitions are
appended to the rollout buffer and share the team's terminal return.

Trade-off:

- Pros: 2x transitions per game, the policy learns to coordinate with
  itself (which matches deployment), seat is a feature so seat-conditional
  behaviour is still possible.
- Cons: same-game transitions are correlated, credit assignment between
  the two teammates is loose.

For the v3.0 milestone and beyond, a **frozen partner / opponent pool**
(see "Self-play and frozen pool" below) reduces the credit-assignment
issue without sacrificing the data-efficiency of shared self-play.

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

For the full curriculum (v2.6 milestone → v3.0 milestone → self-play →
gauntlet) use `run_curriculum.sh`, which snapshots milestone winners
under `checkpoints/milestones/` and chains the phases automatically.
The sections below describe the underlying single-milestone loop and
the manual step-by-step variant.

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

**Logs (live updates):** With `TIMESTAMPED_LOGGING=1` (default), lines are written to
`RUN_LOG_PATH` or `CHECKPOINT_ROOT/selfplay_<timestamp>.log`. Because Node and Python
often **block-buffer** when stdout is a pipe, the script also appends a **heartbeat**
every `LOG_HEARTBEAT_SECS` seconds (default **60**) directly to that file (same style as
the old v1 training runs). Set `LOG_HEARTBEAT_SECS=0` to disable. Child processes are
wrapped with `stdbuf -oL -eL` when available (install **GNU coreutils** on macOS via
Homebrew and use `stdbuf`, or `gstdbuf` on `PATH`) and `PYTHONUNBUFFERED=1` is set so
rollout/PPO lines **flush** into the timestamped stream more reliably.

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

## Curriculum

The recommended PPO path is **two heuristic milestones**, then
neural-neighbour training — **not** a ladder through every legacy version:

```text
legacy-v2.6  (PPO training opponent; first milestone)
   -> legacy-v3.0  (PPO training opponent; second milestone, optional frozen partner pool)
   -> self-play vs frozen ScoreNet pool (strongest signal when heuristics saturate)
   -> gauntlet (eval only): e.g. legacy-v1, v2.6, v2.7, v3.0 — v2.7 is benchmark-only, not a training stage
```

`legacy-v2.7` is **not** used as a curriculum training opponent here; PPO
goes **straight from the v2.6 milestone to training against v3.0** (the strong
heuristic). You may still run `legacy-v2.7` in the **gauntlet** to measure
how the policy sits between tiers.

Each milestone reuses the previous milestone's final checkpoint via
`INIT_CHECKPOINT`. Stop conditions:

- v2.6 milestone: win rate > 0.65 over 40 duplicate-dealt eval matches.
- v3.0 milestone: win rate > 0.45 over 40 duplicate-dealt eval matches.
- Self-play: open-ended, periodically benchmarked vs `legacy-v3.0`.

### v2.6 milestone

```bash
INIT_CHECKPOINT=path/to/imitation_or_prior.pt \
OPPONENT_PROFILE=legacy-v2.6 \
EVAL_MATCHES=40 \
ROLLOUT_MATCHES=300 \
TEMPERATURE=0.5 \
STOP_MIN_WIN_RATE=0.65 \
SCORENET_DEVICE=mps \
training/scorenet/selfplay_loop.sh
```

When the loop stops, snapshot the winning checkpoint:

```bash
mkdir -p training/scorenet/checkpoints/milestones
cp <winning epoch_NNN.pt> training/scorenet/checkpoints/milestones/v26_winner.pt
```

### v3.0 milestone (with frozen teammate pool)

```bash
INIT_CHECKPOINT=training/scorenet/checkpoints/milestones/v26_winner.pt \
OPPONENT_PROFILE=legacy-v3.0 \
ROLLOUT_REGIME=frozen_teammate \
FROZEN_POOL_CHECKPOINTS=training/scorenet/checkpoints/milestones/v26_winner.pt \
FROZEN_PARTNER_PROB=0.25 \
EVAL_MATCHES=40 FULL_EVAL_MATCHES=100 \
ROLLOUT_MATCHES=400 TEMPERATURE=0.5 \
PPO_LEARNING_RATE=5e-5 \
STOP_MIN_WIN_RATE=0.45 \
SCORENET_DEVICE=mps \
training/scorenet/selfplay_loop.sh
```

Snapshot to `milestones/v30_contender.pt` once the win-rate condition fires.

### Self-play and frozen pool

After v3.0 the heuristic ceiling stops being informative. Use
`run_selfplay.sh`:

```bash
INIT_CHECKPOINT=training/scorenet/checkpoints/milestones/v30_contender.pt \
FROZEN_POOL_DIR=training/scorenet/checkpoints/milestones \
training/scorenet/run_selfplay.sh
```

`run_selfplay.sh` defaults to `ROLLOUT_REGIME=selfplay_mixed`, which draws
each match's seat layout 50/50 from:

- `selfplay_2v2`: learner on seats 0 and 2, frozen pool on seats 1 and 3
  (cheap, 2x transitions per match, both learner seats train).
- `selfplay_solo`: learner on seat 0 only, frozen pool on seats 1, 2, 3
  (cleanest credit assignment, half the data).

Eval continues to run vs the configured `OPPONENT_PROFILE` (default
`legacy-v3.0`) so progress remains comparable to the curriculum
milestones.

#### Rollout regimes (`ROLLOUT_REGIME` env)

| Regime | Seat 0 | Seat 1 | Seat 2 | Seat 3 | Use |
|---|---|---|---|---|---|
| `heuristic` (default) | learner | heuristic | learner | heuristic | vs heuristic baseline |
| `frozen_teammate` | learner | heuristic | learner or frozen | heuristic | v3.0 phase |
| `selfplay_2v2` | learner | frozen | learner | frozen | self-play, 2x data |
| `selfplay_solo` | learner | frozen | frozen | frozen | self-play, clean credit |
| `selfplay_mixed` | per-match 50/50 of `selfplay_2v2` and `selfplay_solo` | | | | self-play default |

Required env when any regime uses `frozen`:

- `FROZEN_POOL_CHECKPOINTS`: comma-separated list of `.pt` paths.
- Optional `FROZEN_PARTNER_PROB`: probability of replacing seat 2 with a
  frozen checkpoint in `frozen_teammate` mode (default 0).
- Optional `FROZEN_POOL_TEMPERATURE`: sampling temperature for the frozen
  pool (default = `TEMPERATURE`).

When a seat is `frozen`, transitions on that seat are **not** appended to
the PPO rollout buffer. Only learner-seat transitions are kept, which
keeps the gradient clean.

### Eval (duplicate dealing)

`evaluate.ts` defaults to `EVAL_DUPLICATE_DEALS=1`, which plays each base
seed twice with the learner's team flipped. This roughly halves variance
from card luck. Set `EVAL_DUPLICATE_DEALS=0` to recover the older
unpaired behaviour. ScoreNet runs greedy at eval time
(`sample: false`).

### Final gauntlet

After self-play, run the gauntlet to benchmark vs every heuristic
version:

```bash
CHECKPOINT=path/to/final.pt \
MATCHES=200 \
training/scorenet/run_gauntlet.sh
```

Output:

- `training/scorenet/reports/gauntlet_<timestamp>/<opponent>.json` per opponent.
- `training/scorenet/reports/gauntlet_<timestamp>/README.md` with win rates and 95% Wilson CIs.

## Hardware

The pipeline runs on CPU but is dramatically faster on GPU. Use
`SCORENET_DEVICE=mps` on Apple Silicon (validated; Metal Performance
Shaders) or `SCORENET_DEVICE=cuda` on NVIDIA GPUs. The default is
auto-detection in `pick_device` (`runtime_utils.py`).

Rollout generation and evaluation are parallelised across processes via
`ROLLOUT_WORKERS` and `EVAL_WORKERS` (default 8 each); each worker spawns
its own `serve_policy.py` subprocess.

## Reproducing a milestone from scratch

1. Generate imitation data and warm-start checkpoint (one-off):

   ```bash
   training/scorenet/selfplay_loop.sh # with no INIT_CHECKPOINT
   ```

   This will export imitation data, train an imitation checkpoint, then
   start PPO. Stop after one or two iterations.

2. Run the v2.6 milestone (see "Curriculum" above), snapshot the
   winning checkpoint to `milestones/v26_winner.pt`.

3. Run the v3.0 milestone, snapshot to `milestones/v30_contender.pt`.

4. Run self-play with `run_selfplay.sh`.

5. Run the gauntlet with `run_gauntlet.sh`.

All runs are deterministic given fixed `BASE_SEED`, hardware, and the
order of rollout workers. Win-rate noise dominates anything else
in this regime, so prefer larger `MATCHES` over fixing the seed when
comparing checkpoints.

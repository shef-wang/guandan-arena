# ScoreNet Training History (Handoff for Next Agent)

## 1) Current Snapshot

- Project root: `guandan`
- Training stack path: `training/scorenet/`
- Platform used in runs so far: MacBook Pro M2 Pro (16 GB)
- Runtime from logs: PyTorch on `mps` (Apple GPU) during PPO training
- Stop target discussed: **net level delta >= +30** (learned team perspective)

## 2) Pipeline Status

The following pipeline components are implemented and working:

- `export_ppo_rollouts.ts` (rollout generation)
- `train_ppo.py` (PPO update)
- `evaluate.ts` (eval vs `legacy-v1`)
- `selfplay_loop.sh` (orchestration)
- `train_imitation.py` + `export_imitation_dataset.ts` (warm start path)

Known behavior:

- Rollout phase is mostly silent until completion (can look "stuck" while healthy).
- PPO/eval phases print dense logs as expected.

## 3) Artifact Inventory

Checkpoint/eval directories currently present:

- `training/scorenet/checkpoints/ppo_iter_001/`
- `training/scorenet/checkpoints/ppo_iter_002/`
- `training/scorenet/checkpoints/ppo_iter_003/`
- `training/scorenet/checkpoints/ppo_iter_004/` (rollout only; no eval)
- `training/scorenet/checkpoints/ppo_iter_004_retry/`
- `training/scorenet/checkpoints/ppo_iter_001/ppo_plus10/` (extra 10 epochs from `ppo_iter_001/ppo/epoch_004.pt`)

Important note:

- `ppo_iter_001` was reused in a later one-iteration run, so naming is not strictly chronological across all experiments.
- Prefer using explicit run IDs in future (example: `run_2026xxxx_iter_001`) to avoid collisions.

## 4) Run History (Observed)

### A) Earlier multi-iteration PPO run (smoke-init branch)

Completed eval artifacts:

- `ppo_iter_002/eval_summary.json`
- `ppo_iter_003/eval_summary.json`

Plus:

- `ppo_iter_004/rollout_summary.json` exists, but no matching eval (run stopped mid-iteration).

### B) One measured retry iteration

- Base checkpoint: `ppo_iter_003/ppo/epoch_004.pt`
- Output: `ppo_iter_004_retry/`
- Completed rollout + PPO + eval.

### C) One fresh one-iteration loop

- Base checkpoint: `ppo_iter_004_retry/ppo/epoch_004.pt`
- Output written to `ppo_iter_001/` (name reused)
- Completed rollout + PPO + eval.

### D) Extra 10 PPO epochs (no rollout regeneration)

- Command trained from: `ppo_iter_001/ppo/epoch_004.pt`
- Output: `ppo_iter_001/ppo_plus10/epoch_010.pt`
- Then evaluated on 200 matches and saved:
  - `ppo_iter_001/ppo_plus10/eval_200_matches.json`

## 5) Eval Metrics So Far

All values below are from saved JSON artifacts.

### `ppo_iter_002/eval_summary.json`

- Matches: 60
- Learned wins: 22 (36.67%)
- Legacy wins: 38 (63.33%)
- Learned avg level gain on wins: 2.1364
- Legacy avg level gain on wins: 2.2368
- Net level delta (computed): `22*2.1364 - 38*2.2368 ≈ -38`

### `ppo_iter_003/eval_summary.json`

- Matches: 60
- Learned wins: 27 (45.00%)
- Legacy wins: 33 (55.00%)
- Learned avg level gain on wins: 2.1481
- Legacy avg level gain on wins: 2.4242
- Net level delta (computed): `27*2.1481 - 33*2.4242 ≈ -22`

### `ppo_iter_004_retry/eval_summary.json`

- Matches: 60
- Learned wins: 22 (36.67%)
- Legacy wins: 38 (63.33%)
- LearnedLevelGainTotal: 43
- LegacyLevelGainTotal: 91
- Net level delta: **-48** (per match -0.8)

### `ppo_iter_001/eval_summary.json` (from later reused `ppo_iter_001`)

- Matches: 60
- Learned wins: 23 (38.33%)
- Legacy wins: 37 (61.67%)
- LearnedLevelGainTotal: 53
- LegacyLevelGainTotal: 83
- Net level delta: **-30** (per match -0.5)

### `ppo_iter_001/ppo_plus10/eval_200_matches.json`

- Matches: 200
- Learned wins: 80 (40.00%)
- Legacy wins: 120 (60.00%)
- LearnedLevelGainTotal: 157
- LegacyLevelGainTotal: 275
- Net level delta: **-118** (per match -0.59)

## 6) Throughput / Timing

Measured one full iteration (120 rollout matches, 4 PPO epochs, 60 eval matches):

- Rollout: ~359s
- PPO train: ~31s
- Eval: ~130s
- Total: ~520s (~8.7 min)

Practical estimate:

- **~9-10 minutes per iteration** on this machine/config.

## 7) What Is Working vs Not Working

Working:

- Training loop is stable (no NaN crashes after entropy masking fix).
- PPO losses improve during epochs.
- GPU (`mps`) is used during train/eval.

Not yet achieved:

- Target `netLevelDelta >= +30` has **not** been reached.
- Current evaluations remain net-negative vs `legacy-v1`.

## 8) Recommendations for Next Agent (Mac Mini)

1. Use clear run directory naming to avoid overwrite:
   - Example: `training/scorenet/checkpoints/run_20260417_iter_001`
2. Keep one-iteration control loop for observability.
3. After each iteration, record:
   - rollout summary,
   - PPO history,
   - eval summary with net level delta.
4. Track stop criterion:
   - `netLevelDeltaFromLearnedPerspective >= 30`
5. Prefer larger eval match count (>=200) for important comparisons.

## 9) Command Cheatsheet (Mac Mini)

### Build runners

```bash
npx esbuild training/scorenet/export_ppo_rollouts.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_ppo.cjs
npx esbuild training/scorenet/evaluate.ts --bundle --platform=node --format=cjs --outfile=/tmp/scorenet_eval.cjs
```

### Run one controlled iteration

```bash
ITER_DIR=training/scorenet/checkpoints/run_YYYYMMDD_iter_001
mkdir -p "$ITER_DIR"

CHECKPOINT=training/scorenet/checkpoints/ppo_iter_003/ppo/epoch_004.pt \
MATCHES=120 BASE_SEED=20290001 OUTPUT_PATH="$ITER_DIR/rollout.jsonl" \
PYTHON_BIN=.venv-danzero/bin/python node /tmp/scorenet_ppo.cjs | tee "$ITER_DIR/rollout_summary.json"

.venv-danzero/bin/python training/scorenet/train_ppo.py \
  --rollout "$ITER_DIR/rollout.jsonl" \
  --init-checkpoint training/scorenet/checkpoints/ppo_iter_003/ppo/epoch_004.pt \
  --output-dir "$ITER_DIR/ppo" \
  --epochs 4 --batch-size 128 | tee "$ITER_DIR/train_log.jsonl"

CHECKPOINT="$ITER_DIR/ppo/epoch_004.pt" \
MATCHES=200 BASE_SEED=20290002 \
PYTHON_BIN=.venv-danzero/bin/python node /tmp/scorenet_eval.cjs | tee "$ITER_DIR/eval_summary.json"
```

### Extra epochs on existing rollout

```bash
.venv-danzero/bin/python training/scorenet/train_ppo.py \
  --rollout training/scorenet/checkpoints/ppo_iter_001/rollout.jsonl \
  --init-checkpoint training/scorenet/checkpoints/ppo_iter_001/ppo/epoch_004.pt \
  --output-dir training/scorenet/checkpoints/ppo_iter_001/ppo_plus10 \
  --epochs 10 --batch-size 128
```

---

If picking one base to continue from today, use whichever has the best **net level delta per match** on a shared 200-match eval seed set, then iterate from there.

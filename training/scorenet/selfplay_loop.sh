#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-.venv-danzero/bin/python}"
BASE_SEED="${BASE_SEED:-20260416}"
ITERATIONS="${ITERATIONS:-50}"
ROLLOUT_MATCHES="${ROLLOUT_MATCHES:-200}"
EVAL_MATCHES="${EVAL_MATCHES:-100}"
PPO_EPOCHS="${PPO_EPOCHS:-4}"
TRAIN_EPOCHS="${TRAIN_EPOCHS:-8}"

IMITATION_TRAIN="${IMITATION_TRAIN:-training/scorenet/data/imitation_train.jsonl}"
IMITATION_VALID="${IMITATION_VALID:-training/scorenet/data/imitation_valid.jsonl}"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-training/scorenet/checkpoints}"
INIT_CHECKPOINT="${INIT_CHECKPOINT:-}"

EXPORT_IMITATION_BUNDLE="/tmp/scorenet_export_imitation.cjs"
EXPORT_PPO_BUNDLE="/tmp/scorenet_export_ppo.cjs"
EVAL_BUNDLE="/tmp/scorenet_eval.cjs"

mkdir -p "$CHECKPOINT_ROOT"
mkdir -p training/scorenet/data

echo "[scorenet] bundling TypeScript scripts..."
npx esbuild training/scorenet/export_imitation_dataset.ts --bundle --platform=node --format=cjs --outfile="$EXPORT_IMITATION_BUNDLE"
npx esbuild training/scorenet/export_ppo_rollouts.ts --bundle --platform=node --format=cjs --outfile="$EXPORT_PPO_BUNDLE"
npx esbuild training/scorenet/evaluate.ts --bundle --platform=node --format=cjs --outfile="$EVAL_BUNDLE"

if [[ -z "$INIT_CHECKPOINT" ]]; then
  echo "[scorenet] no INIT_CHECKPOINT supplied; generating imitation dataset..."
  MATCHES="${IMITATION_MATCHES:-5000}" \
  BASE_SEED="$BASE_SEED" \
  TRAIN_OUTPUT_PATH="$IMITATION_TRAIN" \
  VALID_OUTPUT_PATH="$IMITATION_VALID" \
  node "$EXPORT_IMITATION_BUNDLE"

  IMITATION_RUN_DIR="$CHECKPOINT_ROOT/imitation_run_$(date +%Y%m%d_%H%M%S)"
  echo "[scorenet] training imitation checkpoint at $IMITATION_RUN_DIR ..."
  "$PYTHON_BIN" training/scorenet/train_imitation.py \
    --train "$IMITATION_TRAIN" \
    --valid "$IMITATION_VALID" \
    --output-dir "$IMITATION_RUN_DIR" \
    --epochs "$TRAIN_EPOCHS"

  INIT_CHECKPOINT="$IMITATION_RUN_DIR/epoch_$(printf '%03d' "$TRAIN_EPOCHS").pt"
fi

CURRENT_CHECKPOINT="$INIT_CHECKPOINT"
echo "[scorenet] starting PPO loop from: $CURRENT_CHECKPOINT"

for ((iter=1; iter<=ITERATIONS; iter++)); do
  echo "[scorenet] ===== iteration $iter / $ITERATIONS ====="
  RUN_DIR="$CHECKPOINT_ROOT/ppo_iter_$(printf '%03d' "$iter")"
  mkdir -p "$RUN_DIR"

  ROLLOUT_PATH="$RUN_DIR/rollout.jsonl"
  SUMMARY_PATH="$RUN_DIR/rollout_summary.json"

  echo "[scorenet] generating rollouts..."
  CHECKPOINT="$CURRENT_CHECKPOINT" \
  MATCHES="$ROLLOUT_MATCHES" \
  BASE_SEED="$((BASE_SEED + iter * 1000))" \
  OUTPUT_PATH="$ROLLOUT_PATH" \
  PYTHON_BIN="$PYTHON_BIN" \
  node "$EXPORT_PPO_BUNDLE" | tee "$SUMMARY_PATH"

  echo "[scorenet] PPO training..."
  PPO_DIR="$RUN_DIR/ppo"
  "$PYTHON_BIN" training/scorenet/train_ppo.py \
    --rollout "$ROLLOUT_PATH" \
    --init-checkpoint "$CURRENT_CHECKPOINT" \
    --output-dir "$PPO_DIR" \
    --epochs "$PPO_EPOCHS"

  CURRENT_CHECKPOINT="$PPO_DIR/epoch_$(printf '%03d' "$PPO_EPOCHS").pt"
  echo "[scorenet] updated checkpoint: $CURRENT_CHECKPOINT"

  echo "[scorenet] evaluating vs legacy-v1..."
  CHECKPOINT="$CURRENT_CHECKPOINT" \
  MATCHES="$EVAL_MATCHES" \
  BASE_SEED="$((BASE_SEED + iter * 2000))" \
  PYTHON_BIN="$PYTHON_BIN" \
  node "$EVAL_BUNDLE" | tee "$RUN_DIR/eval_summary.json"
done

echo "[scorenet] training loop complete."
echo "[scorenet] final checkpoint: $CURRENT_CHECKPOINT"

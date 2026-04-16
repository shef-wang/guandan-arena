#!/usr/bin/env bash
#
# Online self-play PPO training loop.
# Iterates: generate rollouts -> train PPO -> evaluate -> repeat
#
# Environment variables:
#   INIT_CHECKPOINT  - Path to initial checkpoint (required)
#   ITERATIONS       - Number of outer loop iterations (default: 10)
#   MATCHES_PER_ITER - Rollout matches per iteration (default: 128)
#   EVAL_MATCHES     - Evaluation matches vs legacy (default: 40)
#   PPO_EPOCHS       - PPO epochs per iteration (default: 4)
#   BATCH_SIZE       - PPO batch size (default: 256)
#   TEMPERATURE      - Sampling temperature for rollouts (default: 0.9)
#   GAE_LAMBDA       - GAE lambda (default: 0.95)
#   GAMMA            - Discount factor (default: 1.0)
#   OPPONENT_MODE    - "self" | "legacy" | "mixed" (default: "mixed")
#   PYTHON_BIN       - Python binary (default: .venv-danzero/bin/python)
#   OUTPUT_DIR       - Output directory (default: training/danzero_mvp/runs/selfplay_001)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

INIT_CHECKPOINT="${INIT_CHECKPOINT:?INIT_CHECKPOINT is required}"
ITERATIONS="${ITERATIONS:-10}"
MATCHES_PER_ITER="${MATCHES_PER_ITER:-128}"
EVAL_MATCHES="${EVAL_MATCHES:-40}"
PPO_EPOCHS="${PPO_EPOCHS:-4}"
BATCH_SIZE="${BATCH_SIZE:-256}"
TEMPERATURE="${TEMPERATURE:-0.9}"
GAE_LAMBDA="${GAE_LAMBDA:-0.95}"
GAMMA="${GAMMA:-1.0}"
OPPONENT_MODE="${OPPONENT_MODE:-mixed}"
PYTHON_BIN="${PYTHON_BIN:-.venv-danzero/bin/python}"
OUTPUT_DIR="${OUTPUT_DIR:-training/danzero_mvp/runs/selfplay_001}"

mkdir -p "$OUTPUT_DIR"

CURRENT_CHECKPOINT="$INIT_CHECKPOINT"
OPPONENT_CHECKPOINTS=("$INIT_CHECKPOINT")

BUNDLE="/tmp/selfplay_rollout_bundle.cjs"
EVAL_BUNDLE="/tmp/selfplay_eval_bundle.cjs"

echo "Building TS bundles..."
npx esbuild training/danzero_mvp/export_selfplay_ppo_dataset.ts \
  --bundle --platform=node --format=cjs --outfile="$BUNDLE" 2>/dev/null
npx esbuild training/danzero_mvp/run_learned_vs_legacy.ts \
  --bundle --platform=node --format=cjs --outfile="$EVAL_BUNDLE" 2>/dev/null

echo "=== Online Self-Play Training ==="
echo "Init checkpoint: $INIT_CHECKPOINT"
echo "Iterations: $ITERATIONS"
echo "Matches/iter: $MATCHES_PER_ITER"
echo "Opponent mode: $OPPONENT_MODE"
echo ""

for iter in $(seq 1 "$ITERATIONS"); do
  echo "--- Iteration $iter / $ITERATIONS ---"
  ITER_DIR="$OUTPUT_DIR/iter_$(printf '%03d' $iter)"
  mkdir -p "$ITER_DIR"
  ROLLOUT_PATH="$ITER_DIR/rollout.jsonl"

  # Select opponent checkpoint
  if [ "$OPPONENT_MODE" = "self" ]; then
    OPPONENT_CHECKPOINT="$CURRENT_CHECKPOINT"
  elif [ "$OPPONENT_MODE" = "legacy" ]; then
    OPPONENT_CHECKPOINT=""  # Uses built-in heuristic via the exporter
  else
    # Mixed: 50% self, 25% random older checkpoint, 25% legacy
    ROLL=$((RANDOM % 4))
    if [ "$ROLL" -lt 2 ]; then
      OPPONENT_CHECKPOINT="$CURRENT_CHECKPOINT"
    elif [ "$ROLL" -eq 2 ] && [ ${#OPPONENT_CHECKPOINTS[@]} -gt 1 ]; then
      RAND_IDX=$((RANDOM % ${#OPPONENT_CHECKPOINTS[@]}))
      OPPONENT_CHECKPOINT="${OPPONENT_CHECKPOINTS[$RAND_IDX]}"
    else
      OPPONENT_CHECKPOINT=""
    fi
  fi

  # Generate rollouts
  echo "  Generating rollouts (checkpoint=$CURRENT_CHECKPOINT)..."
  CHECKPOINT="$CURRENT_CHECKPOINT" \
  MATCHES="$MATCHES_PER_ITER" \
  BASE_SEED="$((20260413 + iter * 1000))" \
  TEMPERATURE="$TEMPERATURE" \
  GAE_LAMBDA="$GAE_LAMBDA" \
  GAMMA="$GAMMA" \
  OUTPUT_PATH="$ROLLOUT_PATH" \
  PYTHON_BIN="$PYTHON_BIN" \
  node "$BUNDLE" > "$ITER_DIR/rollout_summary.json" 2>"$ITER_DIR/rollout_stderr.log"

  SAMPLE_COUNT=$(wc -l < "$ROLLOUT_PATH" | tr -d ' ')
  echo "  Rollout complete: $SAMPLE_COUNT samples"

  # Train PPO
  echo "  Training PPO (epochs=$PPO_EPOCHS, batch=$BATCH_SIZE)..."
  "$PYTHON_BIN" training/danzero_mvp/train_ppo.py \
    --rollout "$ROLLOUT_PATH" \
    --init-checkpoint "$CURRENT_CHECKPOINT" \
    --output-dir "$ITER_DIR/checkpoints" \
    --epochs "$PPO_EPOCHS" \
    --batch-size "$BATCH_SIZE" \
    --seed "$((20260413 + iter))" \
    > "$ITER_DIR/train_log.jsonl" 2>&1

  # Update checkpoint
  LAST_EPOCH=$(printf '%03d' $PPO_EPOCHS)
  CURRENT_CHECKPOINT="$ITER_DIR/checkpoints/epoch_$LAST_EPOCH.pt"
  OPPONENT_CHECKPOINTS+=("$CURRENT_CHECKPOINT")
  echo "  New checkpoint: $CURRENT_CHECKPOINT"

  # Evaluate vs legacy
  echo "  Evaluating vs legacy-v1 ($EVAL_MATCHES matches)..."
  CHECKPOINT="$CURRENT_CHECKPOINT" \
  MATCHES="$EVAL_MATCHES" \
  BASE_SEED="20260413" \
  PYTHON_BIN="$PYTHON_BIN" \
  node "$EVAL_BUNDLE" > "$ITER_DIR/eval_result.json" 2>"$ITER_DIR/eval_stderr.log" || true

  if [ -f "$ITER_DIR/eval_result.json" ]; then
    WIN_RATE=$(node -e "const d=require('$ITER_DIR/eval_result.json'); console.log(d.summary?.learnedWinRate ?? 'N/A')" 2>/dev/null || echo "N/A")
    echo "  Eval win rate vs legacy: $WIN_RATE"
  fi

  echo ""
done

echo "=== Training complete ==="
echo "Final checkpoint: $CURRENT_CHECKPOINT"
echo "All iterations saved to: $OUTPUT_DIR"

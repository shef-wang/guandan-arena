#!/usr/bin/env bash
# Launches selfplay_loop.sh. Default ROLLOUT_REGIME is hybrid_selfplay_legacy
# (~90% self-play: latest-vs-latest + prior snapshots; ~10% vs OPPONENT_PROFILE).
# Override HYBRID_LEGACY_FRACTION / FROZEN_PRIOR_PROB to tune. Set ROLLOUT_REGIME=selfplay_mixed
# for a frozen pool (2v2/1v3); then FROZEN_POOL_CHECKPOINTS is required.
# Seed the prior pool before run: training/scorenet/init_prior_manifest.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

INIT_CHECKPOINT="${INIT_CHECKPOINT:?INIT_CHECKPOINT required, e.g. checkpoints/milestones/v26_winner.pt}"
FROZEN_POOL_DIR="${FROZEN_POOL_DIR:-training/scorenet/checkpoints/milestones}"
FROZEN_POOL_CHECKPOINTS="${FROZEN_POOL_CHECKPOINTS:-}"
ROLLOUT_REGIME="${ROLLOUT_REGIME:-hybrid_selfplay_legacy}"

if [[ "$ROLLOUT_REGIME" != "hybrid_selfplay_legacy" ]]; then
  if [[ -z "$FROZEN_POOL_CHECKPOINTS" ]]; then
    if [[ -d "$FROZEN_POOL_DIR" ]]; then
      POOL_FILES=()
      while IFS= read -r f; do POOL_FILES+=("$f"); done < <(ls "$FROZEN_POOL_DIR"/*.pt 2>/dev/null || true)
      if (( ${#POOL_FILES[@]} == 0 )); then
        echo "No .pt files found in $FROZEN_POOL_DIR. Set FROZEN_POOL_CHECKPOINTS explicitly." >&2
        exit 1
      fi
      FROZEN_POOL_CHECKPOINTS="$(IFS=,; echo "${POOL_FILES[*]}")"
    else
      echo "FROZEN_POOL_DIR=$FROZEN_POOL_DIR does not exist and FROZEN_POOL_CHECKPOINTS is empty." >&2
      exit 1
    fi
  fi
fi

export INIT_CHECKPOINT
export FROZEN_POOL_CHECKPOINTS
export ROLLOUT_REGIME
export OPPONENT_PROFILE="${OPPONENT_PROFILE:-legacy-v3.0}"
export CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-training/scorenet/checkpoints/selfplay_adhoc_$(date +%Y%m%d_%H%M%S)}"
export SNAPSHOT_DIR="${SNAPSHOT_DIR:-$CHECKPOINT_ROOT/prior_snapshots}"
export PRIOR_FILE="${PRIOR_FILE:-$SNAPSHOT_DIR/manifest.txt}"
export TEMPERATURE="${TEMPERATURE:-1.0}"
export FROZEN_POOL_TEMPERATURE="${FROZEN_POOL_TEMPERATURE:-$TEMPERATURE}"
export HYBRID_LEGACY_FRACTION="${HYBRID_LEGACY_FRACTION:-0.2}"
export FROZEN_PRIOR_PROB="${FROZEN_PRIOR_PROB:-0.3}"
export ROLLOUT_MATCHES="${ROLLOUT_MATCHES:-300}"
export ROLLOUT_WORKERS="${ROLLOUT_WORKERS:-8}"
export PPO_BATCH_SIZE="${PPO_BATCH_SIZE:-1024}"
export PPO_ENTROPY_COEF="${PPO_ENTROPY_COEF:-0.01}"
export PPO_EPOCHS_AUTO="${PPO_EPOCHS_AUTO:-1}"
export PPO_EPOCHS="${PPO_EPOCHS:-10}"
export PPO_EPOCHS_MIN="${PPO_EPOCHS_MIN:-6}"
export PPO_EPOCHS_MAX="${PPO_EPOCHS_MAX:-15}"
export PPO_TARGET_KL="${PPO_TARGET_KL:-0.02}"
export EVAL_MATCHES="${EVAL_MATCHES:-40}"
export FULL_EVAL_MATCHES="${FULL_EVAL_MATCHES:-100}"
export EVAL_EVERY="${EVAL_EVERY:-1}"
export FULL_EVAL_EVERY="${FULL_EVAL_EVERY:-5}"
export EVAL_METRIC="${EVAL_METRIC:-pair_level}"
export STOP_STREAK_FULL_EVAL_ONLY="${STOP_STREAK_FULL_EVAL_ONLY:-1}"
export STOP_WHEN_BEAT_FULL_EVAL_ONLY="${STOP_WHEN_BEAT_FULL_EVAL_ONLY:-1}"
export PPO_LEARNING_RATE="${PPO_LEARNING_RATE:-1e-4}"
export SNAPSHOT_EVERY_ITERS="${SNAPSHOT_EVERY_ITERS:-20}"
export SNAPSHOT_MAX="${SNAPSHOT_MAX:-8}"
export EVAL_WORKERS="${EVAL_WORKERS:-4}"
export STOP_STREAK="${STOP_STREAK:-0}"
export STOP_WHEN_BEAT="${STOP_WHEN_BEAT:-0}"
export SCORENET_DEVICE="${SCORENET_DEVICE:-mps}"
export ITERATIONS="${ITERATIONS:-500}"

echo "[selfplay] init=$INIT_CHECKPOINT"
echo "[selfplay] regime=$ROLLOUT_REGIME"
if [[ -n "$FROZEN_POOL_CHECKPOINTS" ]]; then
  echo "[selfplay] frozen pool size=$(echo "$FROZEN_POOL_CHECKPOINTS" | tr ',' '\n' | grep -c . || true)"
else
  echo "[selfplay] frozen pool empty (ok for hybrid; prior snapshots -> $PRIOR_FILE)"
fi
echo "[selfplay] eval opponent=$OPPONENT_PROFILE"
echo "[selfplay] prior manifest: $PRIOR_FILE (seed with training/scorenet/init_prior_manifest.sh)"
echo "[selfplay] stability: legacy_frac=$HYBRID_LEGACY_FRACTION prior_prob=$FROZEN_PRIOR_PROB temp=$TEMPERATURE PPO_TARGET_KL=$PPO_TARGET_KL PPO_EPOCHS=$PPO_EPOCHS PPO_EPOCHS_AUTO=$PPO_EPOCHS_AUTO PPO_EPOCHS_MIN=$PPO_EPOCHS_MIN PPO_EPOCHS_MAX=$PPO_EPOCHS_MAX PPO_LR=$PPO_LEARNING_RATE EVAL_EVERY=$EVAL_EVERY FULL_EVAL_EVERY=$FULL_EVAL_EVERY EVAL_METRIC=$EVAL_METRIC EVAL_WORKERS=$EVAL_WORKERS SNAPSHOT_MAX=$SNAPSHOT_MAX ITERATIONS=$ITERATIONS"

bash training/scorenet/selfplay_loop.sh

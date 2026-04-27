#!/usr/bin/env bash
# Curriculum orchestrator: v2.6 -> v3.0 -> hybrid self-play -> gauntlet.
# Each phase reuses the previous phase's winning checkpoint.
#
# Skip a phase by setting *_SKIP=1, or jump in mid-way by setting *_INIT=path/to/checkpoint.pt.
# Examples:
#   PHASE_V26_SKIP=1 PHASE_V30_INIT=path/to/v26_winner.pt training/scorenet/run_curriculum.sh
#   PHASE_V30_SKIP=1 PHASE_SELFPLAY_INIT=path/to/v26_winner.pt training/scorenet/run_curriculum.sh
#   (default self-play uses ROLLOUT_REGIME=hybrid_selfplay_legacy: 80% mirror self-play, 20% vs legacy)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MILESTONES_DIR="${MILESTONES_DIR:-training/scorenet/checkpoints/milestones}"
mkdir -p "$MILESTONES_DIR"

PYTHON_BIN="${PYTHON_BIN:-.venv-danzero/bin/python}"
SCORENET_DEVICE="${SCORENET_DEVICE:-mps}"
ROLLOUT_WORKERS="${ROLLOUT_WORKERS:-8}"
EVAL_WORKERS="${EVAL_WORKERS:-8}"

PHASE_V26_INIT="${PHASE_V26_INIT:-}"
PHASE_V30_INIT="${PHASE_V30_INIT:-}"
PHASE_SELFPLAY_INIT="${PHASE_SELFPLAY_INIT:-}"
PHASE_GAUNTLET_INIT="${PHASE_GAUNTLET_INIT:-}"

PHASE_V26_SKIP="${PHASE_V26_SKIP:-0}"
PHASE_V30_SKIP="${PHASE_V30_SKIP:-0}"
PHASE_SELFPLAY_SKIP="${PHASE_SELFPLAY_SKIP:-0}"
PHASE_GAUNTLET_SKIP="${PHASE_GAUNTLET_SKIP:-0}"

V26_WINNER="$MILESTONES_DIR/v26_winner.pt"
V30_CONTENDER="$MILESTONES_DIR/v30_contender.pt"
SELFPLAY_FINAL="$MILESTONES_DIR/selfplay_final.pt"

snapshot_winner() {
  local run_dir="$1"
  local dest="$2"
  # Find the highest-numbered ppo_iter_N/ppo/epoch_NNN.pt under run_dir.
  local latest
  latest="$(ls -1 "$run_dir"/ppo_iter_*/ppo/epoch_*.pt 2>/dev/null | sort -V | tail -1)"
  if [[ -z "$latest" ]]; then
    echo "[curriculum] ERROR: no checkpoint found under $run_dir" >&2
    return 1
  fi
  cp "$latest" "$dest"
  # Also copy the latest eval_summary.json for record-keeping.
  local latest_eval
  latest_eval="$(ls -1 "$run_dir"/ppo_iter_*/eval_summary.json 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$latest_eval" ]]; then
    cp "$latest_eval" "${dest%.pt}_eval.json"
  fi
  echo "[curriculum] snapshot -> $dest (from $latest)"
}

run_phase_v26() {
  if [[ "$PHASE_V26_SKIP" == "1" ]]; then
    echo "[curriculum] phase v2.6 skipped"
    return 0
  fi
  if [[ -z "$PHASE_V26_INIT" ]]; then
    echo "[curriculum] ERROR: PHASE_V26_INIT required (path to imitation or prior PPO checkpoint)" >&2
    return 1
  fi
  local run_dir="${V26_RUN_DIR:-training/scorenet/checkpoints/v26_run_$(date +%Y%m%d_%H%M%S)}"
  echo "[curriculum] === phase v2.6 === init=$PHASE_V26_INIT run_dir=$run_dir"
  export RUN_LOG_PATH="${RUN_LOG_PATH:-$run_dir/live.log}"
  echo "[curriculum] log (tail -f): $RUN_LOG_PATH"
  INIT_CHECKPOINT="$PHASE_V26_INIT" \
  CHECKPOINT_ROOT="$run_dir" \
  OPPONENT_PROFILE="legacy-v2.6" \
  ROLLOUT_REGIME="heuristic" \
  ROLLOUT_MATCHES="${V26_ROLLOUT_MATCHES:-300}" \
  EVAL_MATCHES="${V26_EVAL_MATCHES:-40}" \
  FULL_EVAL_MATCHES="${V26_FULL_EVAL_MATCHES:-75}" \
  TEMPERATURE="${V26_TEMPERATURE:-0.5}" \
  STOP_MIN_WIN_RATE="${V26_STOP_MIN_WIN_RATE:-0.65}" \
  STOP_MIN_NET_DELTA="${V26_STOP_MIN_NET_DELTA:--999}" \
  PYTHON_BIN="$PYTHON_BIN" \
  SCORENET_DEVICE="$SCORENET_DEVICE" \
  ROLLOUT_WORKERS="$ROLLOUT_WORKERS" \
  EVAL_WORKERS="$EVAL_WORKERS" \
  bash training/scorenet/selfplay_loop.sh
  snapshot_winner "$run_dir" "$V26_WINNER"
}

run_phase_v30() {
  if [[ "$PHASE_V30_SKIP" == "1" ]]; then
    echo "[curriculum] phase v3.0 skipped"
    return 0
  fi
  local init="${PHASE_V30_INIT:-$V26_WINNER}"
  if [[ ! -f "$init" ]]; then
    echo "[curriculum] ERROR: phase v3.0 init not found: $init" >&2
    return 1
  fi
  local run_dir="${V30_RUN_DIR:-training/scorenet/checkpoints/v30_run_$(date +%Y%m%d_%H%M%S)}"
  echo "[curriculum] === phase v3.0 === init=$init run_dir=$run_dir"
  export RUN_LOG_PATH="${RUN_LOG_PATH:-$run_dir/live.log}"
  echo "[curriculum] log (tail -f): $RUN_LOG_PATH"
  INIT_CHECKPOINT="$init" \
  CHECKPOINT_ROOT="$run_dir" \
  OPPONENT_PROFILE="legacy-v3.0" \
  ROLLOUT_REGIME="frozen_teammate" \
  FROZEN_POOL_CHECKPOINTS="$init" \
  FROZEN_PARTNER_PROB="${V30_FROZEN_PARTNER_PROB:-0.25}" \
  ROLLOUT_MATCHES="${V30_ROLLOUT_MATCHES:-400}" \
  EVAL_MATCHES="${V30_EVAL_MATCHES:-40}" \
  FULL_EVAL_MATCHES="${V30_FULL_EVAL_MATCHES:-100}" \
  TEMPERATURE="${V30_TEMPERATURE:-0.5}" \
  PPO_LEARNING_RATE="${V30_PPO_LEARNING_RATE:-5e-5}" \
  STOP_MIN_WIN_RATE="${V30_STOP_MIN_WIN_RATE:-0.45}" \
  STOP_MIN_NET_DELTA="${V30_STOP_MIN_NET_DELTA:--999}" \
  PYTHON_BIN="$PYTHON_BIN" \
  SCORENET_DEVICE="$SCORENET_DEVICE" \
  ROLLOUT_WORKERS="$ROLLOUT_WORKERS" \
  EVAL_WORKERS="$EVAL_WORKERS" \
  bash training/scorenet/selfplay_loop.sh
  snapshot_winner "$run_dir" "$V30_CONTENDER"
}

run_phase_selfplay() {
  if [[ "$PHASE_SELFPLAY_SKIP" == "1" ]]; then
    echo "[curriculum] phase self-play skipped"
    return 0
  fi
  local init="${PHASE_SELFPLAY_INIT:-}"
  if [[ -z "$init" ]]; then
    if [[ -f "$V30_CONTENDER" ]]; then
      init="$V30_CONTENDER"
    elif [[ -f "$V26_WINNER" ]]; then
      init="$V26_WINNER"
    else
      echo "[curriculum] ERROR: set PHASE_SELFPLAY_INIT or run v2.6/v3.0 phases to produce a milestone" >&2
      return 1
    fi
  fi
  if [[ ! -f "$init" ]]; then
    echo "[curriculum] ERROR: phase self-play init not found: $init" >&2
    return 1
  fi
  local run_dir="${SELFPLAY_RUN_DIR:-training/scorenet/checkpoints/selfplay_run_$(date +%Y%m%d_%H%M%S)}"
  echo "[curriculum] === phase self-play (hybrid default) === init=$init run_dir=$run_dir"
  export RUN_LOG_PATH="${RUN_LOG_PATH:-$run_dir/live.log}"
  echo "[curriculum] log (tail -f): $RUN_LOG_PATH"

  INIT_CHECKPOINT="$init" \
  CHECKPOINT_ROOT="$run_dir" \
  SNAPSHOT_DIR="${SELFPLAY_SNAPSHOT_DIR:-$run_dir/prior_snapshots}" \
  PRIOR_FILE="${PRIOR_FILE:-$run_dir/prior_snapshots/manifest.txt}" \
  OPPONENT_PROFILE="${SELFPLAY_OPPONENT:-legacy-v3.0}" \
  ROLLOUT_REGIME="${SELFPLAY_REGIME:-hybrid_selfplay_legacy}" \
  FROZEN_POOL_CHECKPOINTS="${SELFPLAY_FROZEN_POOL:-}" \
  FROZEN_PRIOR_CHECKPOINTS="${FROZEN_PRIOR_CHECKPOINTS:-}" \
  ROLLOUT_MATCHES="${SELFPLAY_ROLLOUT_MATCHES:-300}" \
  EVAL_MATCHES="${SELFPLAY_EVAL_MATCHES:-40}" \
  EVAL_EVERY="${SELFPLAY_EVAL_EVERY:-10}" \
  FULL_EVAL_MATCHES="${SELFPLAY_FULL_EVAL_MATCHES:-100}" \
  TEMPERATURE="${SELFPLAY_TEMPERATURE:-1.0}" \
  FROZEN_POOL_TEMPERATURE="${SELFPLAY_FROZEN_TEMP:-0.4}" \
  HYBRID_LEGACY_FRACTION="${HYBRID_LEGACY_FRACTION:-0.2}" \
  FROZEN_PRIOR_PROB="${FROZEN_PRIOR_PROB:-0.2}" \
  PPO_BATCH_SIZE="${SELFPLAY_PPO_BATCH_SIZE:-1024}" \
  PPO_ENTROPY_COEF="${SELFPLAY_PPO_ENTROPY_COEF:-0.015}" \
  PPO_LEARNING_RATE="${SELFPLAY_PPO_LEARNING_RATE:-5e-5}" \
  ITERATIONS="${SELFPLAY_ITERATIONS:-200}" \
  SNAPSHOT_EVERY_ITERS="${SNAPSHOT_EVERY_ITERS:-50}" \
  SNAPSHOT_MAX="${SNAPSHOT_MAX:-10}" \
  STOP_STREAK="${SELFPLAY_STOP_STREAK:-3}" \
  STOP_MIN_WIN_RATE="${SELFPLAY_STOP_MIN_WIN_RATE:-0.65}" \
  STOP_MIN_NET_DELTA="${SELFPLAY_STOP_MIN_NET_DELTA:--999}" \
  STOP_WHEN_BEAT="${SELFPLAY_STOP_WHEN_BEAT:-0}" \
  EVAL_STREAK_FILE="${SELFPLAY_EVAL_STREAK_FILE:-$run_dir/eval_streak_state.json}" \
  PYTHON_BIN="$PYTHON_BIN" \
  SCORENET_DEVICE="$SCORENET_DEVICE" \
  ROLLOUT_WORKERS="${SELFPLAY_ROLLOUT_WORKERS:-16}" \
  EVAL_WORKERS="$EVAL_WORKERS" \
  bash training/scorenet/selfplay_loop.sh
  snapshot_winner "$run_dir" "$SELFPLAY_FINAL"
}

run_phase_gauntlet() {
  if [[ "$PHASE_GAUNTLET_SKIP" == "1" ]]; then
    echo "[curriculum] phase gauntlet skipped"
    return 0
  fi
  local init="${PHASE_GAUNTLET_INIT:-$SELFPLAY_FINAL}"
  if [[ ! -f "$init" ]]; then
    init="${V30_CONTENDER:-}"
  fi
  if [[ ! -f "$init" ]]; then
    echo "[curriculum] ERROR: no checkpoint available for gauntlet" >&2
    return 1
  fi
  echo "[curriculum] === phase gauntlet === ckpt=$init"
  CHECKPOINT="$init" \
  MATCHES="${GAUNTLET_MATCHES:-200}" \
  PYTHON_BIN="$PYTHON_BIN" \
  SCORENET_DEVICE="$SCORENET_DEVICE" \
  EVAL_WORKERS="$EVAL_WORKERS" \
  bash training/scorenet/run_gauntlet.sh
}

run_phase_v26
run_phase_v30
run_phase_selfplay
run_phase_gauntlet

echo "[curriculum] complete."

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-.venv-danzero/bin/python}"
BASE_SEED="${BASE_SEED:-20260416}"
ITERATIONS="${ITERATIONS:-50}"
ROLLOUT_MATCHES="${ROLLOUT_MATCHES:-200}"
EVAL_MATCHES="${EVAL_MATCHES:-25}"
PPO_EPOCHS="${PPO_EPOCHS:-16}"
PPO_EPOCHS_AUTO="${PPO_EPOCHS_AUTO:-1}"
PPO_EPOCHS_MIN="${PPO_EPOCHS_MIN:-16}"
PPO_EPOCHS_MAX="${PPO_EPOCHS_MAX:-48}"
PPO_TARGET_UPDATES="${PPO_TARGET_UPDATES:-2500}"
PPO_BATCH_SIZE="${PPO_BATCH_SIZE:-128}"
PPO_DATALOADER_WORKERS="${PPO_DATALOADER_WORKERS:-0}"
TRAIN_EPOCHS="${TRAIN_EPOCHS:-8}"
OPPONENT_PROFILE="${OPPONENT_PROFILE:-legacy-v3.0}"
ROLLOUT_WORKERS="${ROLLOUT_WORKERS:-8}"
CPU_FRACTION="${CPU_FRACTION:-1.0}"
MPS_MEMORY_FRACTION="${MPS_MEMORY_FRACTION:-0.95}"
EVAL_EVERY="${EVAL_EVERY:-3}"
FULL_EVAL_EVERY="${FULL_EVAL_EVERY:-10}"
FULL_EVAL_MATCHES="${FULL_EVAL_MATCHES:-75}"
EVAL_WORKERS="${EVAL_WORKERS:-8}"
STOP_WHEN_BEAT="${STOP_WHEN_BEAT:-1}"
STOP_MIN_NET_DELTA="${STOP_MIN_NET_DELTA:-1}"
STOP_MIN_WIN_RATE="${STOP_MIN_WIN_RATE:-0.5}"
# PPO: entropy bonus (higher = more exploration; default matches train_ppo.py)
PPO_ENTROPY_COEF="${PPO_ENTROPY_COEF:-0.01}"
# After every N iterations, copy the post-PPO checkpoint into SNAPSHOT_DIR and append to PRIOR_FILE (capped).
SNAPSHOT_EVERY_ITERS="${SNAPSHOT_EVERY_ITERS:-0}"
SNAPSHOT_MAX="${SNAPSHOT_MAX:-10}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-}"
# One .pt path per line; FROZEN_PRIOR_CHECKPOINTS for each rollout is rebuilt from this file unless overridden below.
PRIOR_FILE="${PRIOR_FILE:-}"
# Streak: stop after this many consecutive evals with winRate>STOP_MIN and net>=STOP_MIN_NET (0=disabled).
STOP_STREAK="${STOP_STREAK:-0}"
EVAL_STREAK_FILE="${EVAL_STREAK_FILE:-}"

IMITATION_TRAIN="${IMITATION_TRAIN:-training/scorenet/data/imitation_train.jsonl}"
IMITATION_VALID="${IMITATION_VALID:-training/scorenet/data/imitation_valid.jsonl}"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-training/scorenet/checkpoints}"
INIT_CHECKPOINT="${INIT_CHECKPOINT:-}"
TIMESTAMPED_LOGGING="${TIMESTAMPED_LOGGING:-1}"
# Append a line every N seconds to RUN_LOG_PATH even when Node/Python is block-buffered (v1-style heartbeat).
LOG_HEARTBEAT_SECS="${LOG_HEARTBEAT_SECS:-60}"
RUN_LOG_PATH="${RUN_LOG_PATH:-}"
HEARTBEAT_PID=""

EXPORT_IMITATION_BUNDLE="/tmp/scorenet_export_imitation.cjs"
EXPORT_PPO_BUNDLE="/tmp/scorenet_export_ppo.cjs"
EVAL_BUNDLE="/tmp/scorenet_eval.cjs"

# Line-buffer child stdout/stderr when GNU stdbuf is available (common on Homebrew coreutils: gstdbuf).
linebuf() {
  if command -v stdbuf >/dev/null 2>&1; then
    stdbuf -oL -eL -- "$@"
  elif command -v gstdbuf >/dev/null 2>&1; then
    gstdbuf -oL -eL -- "$@"
  else
    "$@"
  fi
}

mkdir -p "$CHECKPOINT_ROOT"
mkdir -p training/scorenet/data

if [[ "$TIMESTAMPED_LOGGING" == "1" ]]; then
  if [[ -z "$RUN_LOG_PATH" ]]; then
    RUN_LOG_PATH="$CHECKPOINT_ROOT/selfplay_$(date +%Y%m%d_%H%M%S).log"
  fi
  mkdir -p "$(dirname "$RUN_LOG_PATH")"
  # Touch + immediate lines: works even if Node/Python block-buffer the main pipe (v3.0 rollouts are slow).
  : >> "$RUN_LOG_PATH"
  printf '[%s] [scorenet] (pre-exec) writing this file: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$RUN_LOG_PATH" >> "$RUN_LOG_PATH" || true
  if [[ -n "$LOG_HEARTBEAT_SECS" && "$LOG_HEARTBEAT_SECS" -gt 0 ]]; then
    (
      printf '[%s] [scorenet] heartbeat: started (repeating every %ss; PROGRESS_EVERY_MATCHES in rollout log)\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" "$LOG_HEARTBEAT_SECS" >> "$RUN_LOG_PATH" || true
      while true; do
        sleep "$LOG_HEARTBEAT_SECS" || break
        printf '[%s] [scorenet] heartbeat: still running\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$RUN_LOG_PATH" || true
      done
    ) &
    HEARTBEAT_PID=$!
  fi
  trap 'if [[ -n "$HEARTBEAT_PID" ]]; then kill "$HEARTBEAT_PID" 2>/dev/null || true; fi' EXIT
  export PYTHONUNBUFFERED=1
  exec > >(
    perl -MPOSIX=strftime -ne 'print "[".strftime("%Y-%m-%d %H:%M:%S", localtime)."] $_";' \
      | tee -a "$RUN_LOG_PATH"
  ) 2>&1
  echo "[scorenet] timestamped logging enabled: $RUN_LOG_PATH"
  if [[ -n "$HEARTBEAT_PID" ]]; then
    echo "[scorenet] file heartbeat: every $LOG_HEARTBEAT_SECS s -> $RUN_LOG_PATH (LOG_HEARTBEAT_SECS=0 to disable)"
  fi
fi

echo "[scorenet] bundling TypeScript scripts..."
linebuf npx esbuild training/scorenet/export_imitation_dataset.ts --bundle --platform=node --format=cjs --outfile="$EXPORT_IMITATION_BUNDLE"
linebuf npx esbuild training/scorenet/export_ppo_rollouts.ts --bundle --platform=node --format=cjs --outfile="$EXPORT_PPO_BUNDLE"
linebuf npx esbuild training/scorenet/evaluate.ts --bundle --platform=node --format=cjs --outfile="$EVAL_BUNDLE"

if [[ -z "$INIT_CHECKPOINT" ]]; then
  echo "[scorenet] no INIT_CHECKPOINT supplied; generating imitation dataset..."
  MATCHES="${IMITATION_MATCHES:-5000}" \
  BASE_SEED="$BASE_SEED" \
  TRAIN_OUTPUT_PATH="$IMITATION_TRAIN" \
  VALID_OUTPUT_PATH="$IMITATION_VALID" \
  linebuf node "$EXPORT_IMITATION_BUNDLE"

  IMITATION_RUN_DIR="$CHECKPOINT_ROOT/imitation_run_$(date +%Y%m%d_%H%M%S)"
  echo "[scorenet] training imitation checkpoint at $IMITATION_RUN_DIR ..."
  linebuf "$PYTHON_BIN" training/scorenet/train_imitation.py \
    --train "$IMITATION_TRAIN" \
    --valid "$IMITATION_VALID" \
    --output-dir "$IMITATION_RUN_DIR" \
    --epochs "$TRAIN_EPOCHS"

  INIT_CHECKPOINT="$IMITATION_RUN_DIR/epoch_$(printf '%03d' "$TRAIN_EPOCHS").pt"
fi

CURRENT_CHECKPOINT="$INIT_CHECKPOINT"
echo "[scorenet] starting PPO loop from: $CURRENT_CHECKPOINT"

# Prior snapshots for hybrid self-play (comma list to export_ppo_rollouts).
if [[ -z "$SNAPSHOT_DIR" ]]; then
  SNAPSHOT_DIR="$CHECKPOINT_ROOT/prior_snapshots"
fi
mkdir -p "$SNAPSHOT_DIR"
if [[ -z "$PRIOR_FILE" ]]; then
  PRIOR_FILE="$SNAPSHOT_DIR/manifest.txt"
fi
: >> "$PRIOR_FILE"
if [[ -z "$EVAL_STREAK_FILE" ]]; then
  EVAL_STREAK_FILE="$CHECKPOINT_ROOT/eval_streak_state.json"
fi

rebuild_frozen_prior_csv() {
  if [[ ! -f "$PRIOR_FILE" ]]; then
    FROZEN_PRIOR_CHECKPOINTS_EXPORT=""
    return 0
  fi
  # grep exits 1 when no lines match; with `set -e` we must not let that abort the script.
  FROZEN_PRIOR_CHECKPOINTS_EXPORT=$(
    (grep -v '^[[:space:]]*$' "$PRIOR_FILE" 2>/dev/null || true) | tr '\n' ',' | sed 's/,$//'
  )
}

for ((iter=1; iter<=ITERATIONS; iter++)); do
  rebuild_frozen_prior_csv
  FROZEN_PRIOR_CSV="${FROZEN_PRIOR_CHECKPOINTS:-${FROZEN_PRIOR_CHECKPOINTS_EXPORT:-}}"
  echo "[scorenet] ===== iteration $iter / $ITERATIONS ====="
  RUN_DIR="$CHECKPOINT_ROOT/ppo_iter_$(printf '%03d' "$iter")"
  mkdir -p "$RUN_DIR"

  ROLLOUT_PATH="$RUN_DIR/rollout.jsonl"
  SUMMARY_PATH="$RUN_DIR/rollout_summary.json"

  echo "[scorenet] generating rollouts..."
  if (( ROLLOUT_WORKERS <= 1 || ROLLOUT_MATCHES <= 1 )); then
    CHECKPOINT="$CURRENT_CHECKPOINT" \
    MATCHES="$ROLLOUT_MATCHES" \
    BASE_SEED="$((BASE_SEED + iter * 1000))" \
    OUTPUT_PATH="$ROLLOUT_PATH" \
    PYTHON_BIN="$PYTHON_BIN" \
    OPPONENT_PROFILE="$OPPONENT_PROFILE" \
    CPU_FRACTION="$CPU_FRACTION" \
    MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
    SCORENET_DEVICE="${SCORENET_DEVICE:-mps}" \
    PROGRESS_EVERY_MATCHES="${PROGRESS_EVERY_MATCHES:-10}" \
    ROLLOUT_WORKER_ID="0" \
    ROLLOUT_REGIME="${ROLLOUT_REGIME:-heuristic}" \
    FROZEN_POOL_CHECKPOINTS="${FROZEN_POOL_CHECKPOINTS:-}" \
    FROZEN_PARTNER_PROB="${FROZEN_PARTNER_PROB:-0}" \
    FROZEN_POOL_DEVICE="${FROZEN_POOL_DEVICE:-}" \
    FROZEN_POOL_TEMPERATURE="${FROZEN_POOL_TEMPERATURE:-}" \
    HYBRID_LEGACY_FRACTION="${HYBRID_LEGACY_FRACTION:-0.2}" \
    FROZEN_PRIOR_PROB="${FROZEN_PRIOR_PROB:-0.2}" \
    FROZEN_PRIOR_CHECKPOINTS="${FROZEN_PRIOR_CSV}" \
    SELFPLAY_2V2_SYMMETRIC="${SELFPLAY_2V2_SYMMETRIC:-0}" \
    TEMPERATURE="${TEMPERATURE:-0.9}" \
    linebuf node "$EXPORT_PPO_BUNDLE" | tee "$SUMMARY_PATH"
  else
    SHARD_DIR="$RUN_DIR/rollout_shards"
    mkdir -p "$SHARD_DIR"
    BASE_MATCHES_PER_WORKER=$((ROLLOUT_MATCHES / ROLLOUT_WORKERS))
    REMAINDER_MATCHES=$((ROLLOUT_MATCHES % ROLLOUT_WORKERS))
    ACTIVE_WORKERS=0
    PIDS=()
    SHARD_OUTPUTS=()
    SHARD_SUMMARIES=()
    echo "[scorenet] rollout parallel mode: workers=$ROLLOUT_WORKERS matches=$ROLLOUT_MATCHES"

    for ((worker=0; worker<ROLLOUT_WORKERS; worker++)); do
      SHARD_MATCHES="$BASE_MATCHES_PER_WORKER"
      if (( worker < REMAINDER_MATCHES )); then
        SHARD_MATCHES=$((SHARD_MATCHES + 1))
      fi
      if (( SHARD_MATCHES <= 0 )); then
        continue
      fi
      ACTIVE_WORKERS=$((ACTIVE_WORKERS + 1))
      SHARD_OUTPUT="$SHARD_DIR/rollout_worker_${worker}.jsonl"
      SHARD_SUMMARY="$SHARD_DIR/summary_worker_${worker}.json"
      SHARD_BASE_SEED="$((BASE_SEED + iter * 100000 + worker * 1000))"
      SHARD_OUTPUTS+=("$SHARD_OUTPUT")
      SHARD_SUMMARIES+=("$SHARD_SUMMARY")

      (
        CHECKPOINT="$CURRENT_CHECKPOINT" \
        MATCHES="$SHARD_MATCHES" \
        BASE_SEED="$SHARD_BASE_SEED" \
        OUTPUT_PATH="$SHARD_OUTPUT" \
        PYTHON_BIN="$PYTHON_BIN" \
        OPPONENT_PROFILE="$OPPONENT_PROFILE" \
        CPU_FRACTION="$CPU_FRACTION" \
        MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
        SCORENET_DEVICE="${SCORENET_DEVICE:-mps}" \
        PROGRESS_EVERY_MATCHES="${PROGRESS_EVERY_MATCHES:-10}" \
        ROLLOUT_WORKER_ID="$worker" \
        ROLLOUT_REGIME="${ROLLOUT_REGIME:-heuristic}" \
        FROZEN_POOL_CHECKPOINTS="${FROZEN_POOL_CHECKPOINTS:-}" \
        FROZEN_PARTNER_PROB="${FROZEN_PARTNER_PROB:-0}" \
        FROZEN_POOL_DEVICE="${FROZEN_POOL_DEVICE:-}" \
        FROZEN_POOL_TEMPERATURE="${FROZEN_POOL_TEMPERATURE:-}" \
        HYBRID_LEGACY_FRACTION="${HYBRID_LEGACY_FRACTION:-0.2}" \
        FROZEN_PRIOR_PROB="${FROZEN_PRIOR_PROB:-0.2}" \
        FROZEN_PRIOR_CHECKPOINTS="${FROZEN_PRIOR_CSV}" \
        SELFPLAY_2V2_SYMMETRIC="${SELFPLAY_2V2_SYMMETRIC:-0}" \
        TEMPERATURE="${TEMPERATURE:-0.9}" \
        linebuf node "$EXPORT_PPO_BUNDLE" > "$SHARD_SUMMARY"
      ) &
      PIDS+=("$!")
    done

    for pid in "${PIDS[@]}"; do
      wait "$pid"
    done

    : > "$ROLLOUT_PATH"
    for shard in "${SHARD_OUTPUTS[@]}"; do
      cat "$shard" >> "$ROLLOUT_PATH"
    done

    linebuf "$PYTHON_BIN" - "$SUMMARY_PATH" "$ROLLOUT_PATH" "${SHARD_SUMMARIES[@]}" <<'PY'
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
rollout_path = Path(sys.argv[2])
summary_files = [Path(p) for p in sys.argv[3:]]
aggregate = {
    "parallel_workers": len(summary_files),
    "matches": 0,
    "sampleCount": 0,
    "team0Wins": 0,
    "team1Wins": 0,
    "averageTurnsPerMatch": 0.0,
    "temperature": None,
    "opponentProfile": None,
    "regime": None,
    "hybridSubCounts": None,
    "shards": [],
    "outputPath": str(rollout_path),
}
total_turns = 0.0
for path in summary_files:
    data = json.loads(path.read_text())
    aggregate["shards"].append(str(path))
    aggregate["matches"] += int(data.get("matches", 0))
    aggregate["sampleCount"] += int(data.get("sampleCount", 0))
    aggregate["team0Wins"] += int(data.get("team0Wins", 0))
    aggregate["team1Wins"] += int(data.get("team1Wins", 0))
    total_turns += float(data.get("averageTurnsPerMatch", 0.0)) * int(data.get("matches", 0))
    if aggregate["temperature"] is None:
        aggregate["temperature"] = data.get("temperature")
    if aggregate["opponentProfile"] is None:
        aggregate["opponentProfile"] = data.get("opponentProfile")
    if aggregate["regime"] is None:
        aggregate["regime"] = data.get("regime")
    sub = data.get("hybridSubCounts") or {}
    if isinstance(sub, dict) and sub:
        if aggregate["hybridSubCounts"] is None:
            aggregate["hybridSubCounts"] = {}
        for k, v in sub.items():
            aggregate["hybridSubCounts"][k] = aggregate["hybridSubCounts"].get(k, 0) + int(v)
if aggregate["matches"] > 0:
    aggregate["averageTurnsPerMatch"] = total_turns / aggregate["matches"]
if not aggregate["hybridSubCounts"]:
    del aggregate["hybridSubCounts"]
if aggregate.get("regime") is None:
    aggregate.pop("regime", None)
summary_path.write_text(json.dumps(aggregate, indent=2) + "\n")
print(json.dumps(aggregate, indent=2))
PY
  fi

  CURRENT_PPO_EPOCHS="$PPO_EPOCHS"
  if [[ "$PPO_EPOCHS_AUTO" == "1" ]]; then
    CURRENT_PPO_EPOCHS="$(linebuf "$PYTHON_BIN" - "$SUMMARY_PATH" "$PPO_TARGET_UPDATES" "$PPO_BATCH_SIZE" "$PPO_EPOCHS_MIN" "$PPO_EPOCHS_MAX" <<'PY'
import json
import math
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
target_updates = max(1, int(float(sys.argv[2])))
batch_size = max(1, int(float(sys.argv[3])))
min_epochs = max(1, int(float(sys.argv[4])))
max_epochs = max(min_epochs, int(float(sys.argv[5])))
summary = json.loads(summary_path.read_text())
sample_count = max(1, int(summary.get("sampleCount", 0)))
updates_per_epoch = max(1, math.ceil(sample_count / batch_size))
epochs = math.ceil(target_updates / updates_per_epoch)
epochs = max(min_epochs, min(max_epochs, epochs))
print(epochs)
PY
)"
  fi

  echo "[scorenet] PPO training... (epochs=$CURRENT_PPO_EPOCHS, batch_size=$PPO_BATCH_SIZE, dataloader_workers=$PPO_DATALOADER_WORKERS)"
  PPO_DIR="$RUN_DIR/ppo"
  linebuf "$PYTHON_BIN" training/scorenet/train_ppo.py \
    --rollout "$ROLLOUT_PATH" \
    --init-checkpoint "$CURRENT_CHECKPOINT" \
    --output-dir "$PPO_DIR" \
    --epochs "$CURRENT_PPO_EPOCHS" \
    --batch-size "$PPO_BATCH_SIZE" \
    --num-workers "$PPO_DATALOADER_WORKERS" \
    --learning-rate "${PPO_LEARNING_RATE:-1e-4}" \
    --clip-eps "${PPO_CLIP_EPS:-0.1}" \
    --target-kl "${PPO_TARGET_KL:-0.03}" \
    --entropy-coef "${PPO_ENTROPY_COEF}" \
    --cpu-fraction "$CPU_FRACTION" \
    --mps-memory-fraction "$MPS_MEMORY_FRACTION"

  CURRENT_CHECKPOINT="$PPO_DIR/epoch_$(printf '%03d' "$CURRENT_PPO_EPOCHS").pt"
  echo "[scorenet] updated checkpoint: $CURRENT_CHECKPOINT"

  if [[ "${SNAPSHOT_EVERY_ITERS:-0}" -gt 0 ]] && (( iter % SNAPSHOT_EVERY_ITERS == 0 )); then
    snap_path="$SNAPSHOT_DIR/iter_$(printf '%03d' "$iter")_$(date +%Y%m%d_%H%M%S).pt"
    cp "$CURRENT_CHECKPOINT" "$snap_path"
    echo "$snap_path" >> "$PRIOR_FILE"
    if [[ -n "$SNAPSHOT_MAX" && "$SNAPSHOT_MAX" -gt 0 ]]; then
      tail -n "$SNAPSHOT_MAX" "$PRIOR_FILE" > "${PRIOR_FILE}.new" && mv "${PRIOR_FILE}.new" "$PRIOR_FILE"
    fi
    echo "[scorenet] snapshot: $snap_path (PRIOR_FILE capped at ${SNAPSHOT_MAX} entries)"
  fi

  DO_EVAL=0
  IS_FULL_EVAL=0
  if (( iter == 1 )); then
    DO_EVAL=1
  fi
  if (( EVAL_EVERY > 0 )); then
    if (( iter % EVAL_EVERY == 0 )); then
      DO_EVAL=1
    fi
  fi
  if (( FULL_EVAL_EVERY > 0 )); then
    if (( iter % FULL_EVAL_EVERY == 0 )); then
      DO_EVAL=1
      IS_FULL_EVAL=1
    fi
  fi

  if (( DO_EVAL == 1 )); then
    MATCHES_THIS_EVAL="$EVAL_MATCHES"
    EVAL_LABEL="fast"
    if (( IS_FULL_EVAL == 1 )); then
      MATCHES_THIS_EVAL="$FULL_EVAL_MATCHES"
      EVAL_LABEL="full"
    fi

    echo "[scorenet] evaluating vs $OPPONENT_PROFILE... ($EVAL_LABEL, matches=$MATCHES_THIS_EVAL, workers=$EVAL_WORKERS)"
    if (( EVAL_WORKERS <= 1 || MATCHES_THIS_EVAL <= 1 )); then
      CHECKPOINT="$CURRENT_CHECKPOINT" \
      MATCHES="$MATCHES_THIS_EVAL" \
      BASE_SEED="$((BASE_SEED + iter * 2000))" \
      PYTHON_BIN="$PYTHON_BIN" \
      OPPONENT_PROFILE="$OPPONENT_PROFILE" \
      CPU_FRACTION="$CPU_FRACTION" \
      MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
      SCORENET_DEVICE="${SCORENET_DEVICE:-mps}" \
      EVAL_DUPLICATE_DEALS="${EVAL_DUPLICATE_DEALS:-1}" \
      linebuf node "$EVAL_BUNDLE" | tee "$RUN_DIR/eval_summary.json"
    else
      EVAL_SHARD_DIR="$RUN_DIR/eval_shards"
      mkdir -p "$EVAL_SHARD_DIR"
      BASE_MATCHES_PER_WORKER=$((MATCHES_THIS_EVAL / EVAL_WORKERS))
      REMAINDER_MATCHES=$((MATCHES_THIS_EVAL % EVAL_WORKERS))
      EVAL_PIDS=()
      EVAL_SUMMARIES=()
      for ((worker=0; worker<EVAL_WORKERS; worker++)); do
        SHARD_MATCHES="$BASE_MATCHES_PER_WORKER"
        if (( worker < REMAINDER_MATCHES )); then
          SHARD_MATCHES=$((SHARD_MATCHES + 1))
        fi
        if (( SHARD_MATCHES <= 0 )); then
          continue
        fi
        SHARD_SUMMARY="$EVAL_SHARD_DIR/eval_worker_${worker}.json"
        SHARD_BASE_SEED="$((BASE_SEED + iter * 200000 + worker * 1000))"
        EVAL_SUMMARIES+=("$SHARD_SUMMARY")
        (
          CHECKPOINT="$CURRENT_CHECKPOINT" \
          MATCHES="$SHARD_MATCHES" \
          BASE_SEED="$SHARD_BASE_SEED" \
          PYTHON_BIN="$PYTHON_BIN" \
          OPPONENT_PROFILE="$OPPONENT_PROFILE" \
          CPU_FRACTION="$CPU_FRACTION" \
          MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
          SCORENET_DEVICE="${SCORENET_DEVICE:-mps}" \
          EVAL_DUPLICATE_DEALS="${EVAL_DUPLICATE_DEALS:-1}" \
          linebuf node "$EVAL_BUNDLE" > "$SHARD_SUMMARY"
        ) &
        EVAL_PIDS+=("$!")
      done
      for pid in "${EVAL_PIDS[@]}"; do
        wait "$pid"
      done
      linebuf "$PYTHON_BIN" - "$RUN_DIR/eval_summary.json" "${EVAL_SUMMARIES[@]}" <<'PY'
import json
import sys
from pathlib import Path

out_path = Path(sys.argv[1])
summary_files = [Path(p) for p in sys.argv[2:]]
if not summary_files:
    raise SystemExit("No eval shard summaries found.")

aggregate = {
    "matches": 0,
    "baseSeed": None,
    "checkpoint": None,
    "opponentProfile": None,
    "learnedLevelGainTotal": 0,
    "legacyLevelGainTotal": 0,
    "netLevelDeltaFromLearnedPerspective": 0,
    "netLevelDeltaPerMatch": 0,
    "learned": {"wins": 0, "winRate": 0, "averageLevelGainOnWins": 0},
    "legacy": {"wins": 0, "winRate": 0, "averageLevelGainOnWins": 0},
    "parallelWorkers": len(summary_files),
    "shards": [str(p) for p in summary_files],
}
for path in summary_files:
    d = json.loads(path.read_text())
    aggregate["matches"] += int(d.get("matches", 0))
    aggregate["learnedLevelGainTotal"] += int(d.get("learnedLevelGainTotal", 0))
    aggregate["legacyLevelGainTotal"] += int(d.get("legacyLevelGainTotal", 0))
    aggregate["learned"]["wins"] += int((d.get("learned") or {}).get("wins", 0))
    aggregate["legacy"]["wins"] += int((d.get("legacy") or {}).get("wins", 0))
    if aggregate["checkpoint"] is None:
        aggregate["checkpoint"] = d.get("checkpoint")
    if aggregate["baseSeed"] is None:
        aggregate["baseSeed"] = d.get("baseSeed")
    if aggregate["opponentProfile"] is None:
        aggregate["opponentProfile"] = d.get("opponentProfile")

matches = max(aggregate["matches"], 1)
aggregate["netLevelDeltaFromLearnedPerspective"] = (
    aggregate["learnedLevelGainTotal"] - aggregate["legacyLevelGainTotal"]
)
aggregate["netLevelDeltaPerMatch"] = aggregate["netLevelDeltaFromLearnedPerspective"] / matches
aggregate["learned"]["winRate"] = aggregate["learned"]["wins"] / matches
aggregate["legacy"]["winRate"] = aggregate["legacy"]["wins"] / matches
aggregate["learned"]["averageLevelGainOnWins"] = (
    aggregate["learnedLevelGainTotal"] / aggregate["learned"]["wins"]
    if aggregate["learned"]["wins"] > 0 else 0
)
aggregate["legacy"]["averageLevelGainOnWins"] = (
    aggregate["legacyLevelGainTotal"] / aggregate["legacy"]["wins"]
    if aggregate["legacy"]["wins"] > 0 else 0
)

out_path.write_text(json.dumps(aggregate, indent=2) + "\n")
print(json.dumps(aggregate, indent=2))
PY
    fi

    STOP_TRAINING=0
    if [[ "${STOP_STREAK:-0}" -gt 0 ]]; then
      if linebuf "$PYTHON_BIN" - "$RUN_DIR/eval_summary.json" "$EVAL_STREAK_FILE" "$STOP_MIN_NET_DELTA" "$STOP_MIN_WIN_RATE" "$STOP_STREAK" "$iter" <<'PY'
import json
import sys
from pathlib import Path

eval_path = Path(sys.argv[1])
streak_path = Path(sys.argv[2])
min_net = float(sys.argv[3])
min_wr = float(sys.argv[4])
required = int(sys.argv[5])
iter_num = int(sys.argv[6])

data = json.loads(eval_path.read_text())
net = float(data.get("netLevelDeltaFromLearnedPerspective", 0))
win_rate = float((data.get("learned") or {}).get("winRate", 0))
ok = net >= min_net and win_rate > min_wr

state = {"streak": 0, "lastIter": 0}
if streak_path.exists():
    state = json.loads(streak_path.read_text())

if ok:
    state["streak"] = int(state.get("streak", 0)) + 1
else:
    state["streak"] = 0
state["lastIter"] = iter_num
streak_path.write_text(json.dumps(state, indent=2) + "\n")

if state["streak"] >= required:
    print(
        f"[scorenet] streak stop: {state['streak']}/{required} strong evals in a row "
        f"(net={net:.3f} >= {min_net}, winRate={win_rate:.4f} > {min_wr})"
    )
    sys.exit(0)
print(
    f"[scorenet] eval streak {state['streak']}/{required}: net={net:.3f}, winRate={win_rate:.4f}"
)
sys.exit(1)
PY
      then
        echo "[scorenet] early stopping after iteration $iter (streak met)."
        STOP_TRAINING=1
      fi
    fi
    if [[ "$STOP_TRAINING" -eq 0 && "$STOP_WHEN_BEAT" == "1" ]]; then
      if linebuf "$PYTHON_BIN" - "$RUN_DIR/eval_summary.json" "$STOP_MIN_NET_DELTA" "$STOP_MIN_WIN_RATE" <<'PY'
import json
import sys
from pathlib import Path

eval_path = Path(sys.argv[1])
min_net = float(sys.argv[2])
min_wr = float(sys.argv[3])
data = json.loads(eval_path.read_text())
net = float(data.get("netLevelDeltaFromLearnedPerspective", 0))
win_rate = float((data.get("learned") or {}).get("winRate", 0))
ok = net >= min_net and win_rate > min_wr
if ok:
    print(
        f"[scorenet] stop condition reached: netLevelDelta={net:.3f} "
        f"(>= {min_net}), winRate={win_rate:.4f} (> {min_wr})"
    )
    sys.exit(0)
print(
    f"[scorenet] continue training: netLevelDelta={net:.3f}, "
    f"winRate={win_rate:.4f} (target net>={min_net}, winRate>{min_wr})"
)
sys.exit(1)
PY
      then
        echo "[scorenet] early stopping after iteration $iter (beat condition met)."
        STOP_TRAINING=1
      fi
    fi
    if [[ "$STOP_TRAINING" -ne 0 ]]; then
      break
    fi
  else
    echo "[scorenet] skipping eval this iteration (EVAL_EVERY=$EVAL_EVERY, FULL_EVAL_EVERY=$FULL_EVAL_EVERY)"
  fi
done

echo "[scorenet] training loop complete."
echo "[scorenet] final checkpoint: $CURRENT_CHECKPOINT"

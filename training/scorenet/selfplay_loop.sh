#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-.venv-danzero/bin/python}"
BASE_SEED="${BASE_SEED:-20260416}"
ITERATIONS="${ITERATIONS:-50}"
ROLLOUT_MATCHES="${ROLLOUT_MATCHES:-200}"
EVAL_MATCHES="${EVAL_MATCHES:-30}"
PPO_EPOCHS="${PPO_EPOCHS:-16}"
TRAIN_EPOCHS="${TRAIN_EPOCHS:-8}"
OPPONENT_PROFILE="${OPPONENT_PROFILE:-legacy-v2.7}"
ROLLOUT_WORKERS="${ROLLOUT_WORKERS:-8}"
CPU_FRACTION="${CPU_FRACTION:-1.0}"
MPS_MEMORY_FRACTION="${MPS_MEMORY_FRACTION:-0.95}"
EVAL_EVERY="${EVAL_EVERY:-3}"
FULL_EVAL_EVERY="${FULL_EVAL_EVERY:-10}"
FULL_EVAL_MATCHES="${FULL_EVAL_MATCHES:-200}"
STOP_WHEN_BEAT="${STOP_WHEN_BEAT:-1}"
STOP_MIN_NET_DELTA="${STOP_MIN_NET_DELTA:-1}"
STOP_MIN_WIN_RATE="${STOP_MIN_WIN_RATE:-0.5}"

IMITATION_TRAIN="${IMITATION_TRAIN:-training/scorenet/data/imitation_train.jsonl}"
IMITATION_VALID="${IMITATION_VALID:-training/scorenet/data/imitation_valid.jsonl}"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-training/scorenet/checkpoints}"
INIT_CHECKPOINT="${INIT_CHECKPOINT:-}"
TIMESTAMPED_LOGGING="${TIMESTAMPED_LOGGING:-1}"
RUN_LOG_PATH="${RUN_LOG_PATH:-}"

EXPORT_IMITATION_BUNDLE="/tmp/scorenet_export_imitation.cjs"
EXPORT_PPO_BUNDLE="/tmp/scorenet_export_ppo.cjs"
EVAL_BUNDLE="/tmp/scorenet_eval.cjs"

mkdir -p "$CHECKPOINT_ROOT"
mkdir -p training/scorenet/data

if [[ "$TIMESTAMPED_LOGGING" == "1" ]]; then
  if [[ -z "$RUN_LOG_PATH" ]]; then
    RUN_LOG_PATH="$CHECKPOINT_ROOT/selfplay_$(date +%Y%m%d_%H%M%S).log"
  fi
  mkdir -p "$(dirname "$RUN_LOG_PATH")"
  exec > >(
    perl -MPOSIX=strftime -ne 'print "[".strftime("%Y-%m-%d %H:%M:%S", localtime)."] $_";' \
      | tee -a "$RUN_LOG_PATH"
  ) 2>&1
  echo "[scorenet] timestamped logging enabled: $RUN_LOG_PATH"
fi

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
  if (( ROLLOUT_WORKERS <= 1 || ROLLOUT_MATCHES <= 1 )); then
    CHECKPOINT="$CURRENT_CHECKPOINT" \
    MATCHES="$ROLLOUT_MATCHES" \
    BASE_SEED="$((BASE_SEED + iter * 1000))" \
    OUTPUT_PATH="$ROLLOUT_PATH" \
    PYTHON_BIN="$PYTHON_BIN" \
    OPPONENT_PROFILE="$OPPONENT_PROFILE" \
    CPU_FRACTION="$CPU_FRACTION" \
    MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
    PROGRESS_EVERY_MATCHES="${PROGRESS_EVERY_MATCHES:-10}" \
    ROLLOUT_WORKER_ID="0" \
    node "$EXPORT_PPO_BUNDLE" | tee "$SUMMARY_PATH"
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
        PROGRESS_EVERY_MATCHES="${PROGRESS_EVERY_MATCHES:-10}" \
        ROLLOUT_WORKER_ID="$worker" \
        node "$EXPORT_PPO_BUNDLE" > "$SHARD_SUMMARY"
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

    "$PYTHON_BIN" - "$SUMMARY_PATH" "$ROLLOUT_PATH" "${SHARD_SUMMARIES[@]}" <<'PY'
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
if aggregate["matches"] > 0:
    aggregate["averageTurnsPerMatch"] = total_turns / aggregate["matches"]
summary_path.write_text(json.dumps(aggregate, indent=2) + "\n")
print(json.dumps(aggregate, indent=2))
PY
  fi

  echo "[scorenet] PPO training..."
  PPO_DIR="$RUN_DIR/ppo"
  "$PYTHON_BIN" training/scorenet/train_ppo.py \
    --rollout "$ROLLOUT_PATH" \
    --init-checkpoint "$CURRENT_CHECKPOINT" \
    --output-dir "$PPO_DIR" \
    --epochs "$PPO_EPOCHS" \
    --cpu-fraction "$CPU_FRACTION" \
    --mps-memory-fraction "$MPS_MEMORY_FRACTION"

  CURRENT_CHECKPOINT="$PPO_DIR/epoch_$(printf '%03d' "$PPO_EPOCHS").pt"
  echo "[scorenet] updated checkpoint: $CURRENT_CHECKPOINT"

  DO_EVAL=0
  IS_FULL_EVAL=0
  if (( iter == 1 )); then
    DO_EVAL=1
  fi
  if (( EVAL_EVERY > 0 && iter % EVAL_EVERY == 0 )); then
    DO_EVAL=1
  fi
  if (( FULL_EVAL_EVERY > 0 && iter % FULL_EVAL_EVERY == 0 )); then
    DO_EVAL=1
    IS_FULL_EVAL=1
  fi

  if (( DO_EVAL == 1 )); then
    MATCHES_THIS_EVAL="$EVAL_MATCHES"
    EVAL_LABEL="fast"
    if (( IS_FULL_EVAL == 1 )); then
      MATCHES_THIS_EVAL="$FULL_EVAL_MATCHES"
      EVAL_LABEL="full"
    fi

    echo "[scorenet] evaluating vs $OPPONENT_PROFILE... ($EVAL_LABEL, matches=$MATCHES_THIS_EVAL)"
    CHECKPOINT="$CURRENT_CHECKPOINT" \
    MATCHES="$MATCHES_THIS_EVAL" \
    BASE_SEED="$((BASE_SEED + iter * 2000))" \
    PYTHON_BIN="$PYTHON_BIN" \
    OPPONENT_PROFILE="$OPPONENT_PROFILE" \
    CPU_FRACTION="$CPU_FRACTION" \
    MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
    SCORENET_DEVICE="${SCORENET_DEVICE:-mps}" \
    node "$EVAL_BUNDLE" | tee "$RUN_DIR/eval_summary.json"

    if [[ "$STOP_WHEN_BEAT" == "1" ]]; then
      if "$PYTHON_BIN" - "$RUN_DIR/eval_summary.json" "$STOP_MIN_NET_DELTA" "$STOP_MIN_WIN_RATE" <<'PY'
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
        break
      fi
    fi
  else
    echo "[scorenet] skipping eval this iteration (EVAL_EVERY=$EVAL_EVERY, FULL_EVAL_EVERY=$FULL_EVAL_EVERY)"
  fi
done

echo "[scorenet] training loop complete."
echo "[scorenet] final checkpoint: $CURRENT_CHECKPOINT"

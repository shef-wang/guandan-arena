#!/usr/bin/env bash
# Final eval-only benchmark. Default OPPONENTS may include legacy-v2.7 for
# reporting; the PPO *training* curriculum is v2.6 -> v3.0 (no v2.7 training stage).
# See training/scorenet/README.md (Curriculum).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CHECKPOINT="${CHECKPOINT:?CHECKPOINT is required}"
PYTHON_BIN="${PYTHON_BIN:-.venv-danzero/bin/python}"
MATCHES="${MATCHES:-200}"
BASE_SEED="${BASE_SEED:-20260420}"
OPPONENTS="${OPPONENTS:-legacy-v1,legacy-v2.6,legacy-v2.7,legacy-v3.0}"
EVAL_WORKERS="${EVAL_WORKERS:-8}"
EVAL_DUPLICATE_DEALS="${EVAL_DUPLICATE_DEALS:-1}"
SCORENET_DEVICE="${SCORENET_DEVICE:-mps}"
CPU_FRACTION="${CPU_FRACTION:-1.0}"
MPS_MEMORY_FRACTION="${MPS_MEMORY_FRACTION:-0.95}"

REPORT_ROOT="${REPORT_ROOT:-training/scorenet/reports}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPORT_ROOT/gauntlet_$TIMESTAMP}"
mkdir -p "$OUTPUT_DIR"

EVAL_BUNDLE="/tmp/scorenet_eval_gauntlet.cjs"
echo "[gauntlet] bundling evaluate.ts -> $EVAL_BUNDLE"
npx esbuild training/scorenet/evaluate.ts --bundle --platform=node --format=cjs --outfile="$EVAL_BUNDLE" >/dev/null

IFS=',' read -r -a OPP_ARR <<< "$OPPONENTS"

for opp in "${OPP_ARR[@]}"; do
  opp_trim="$(echo "$opp" | xargs)"
  if [[ -z "$opp_trim" ]]; then continue; fi
  opp_safe="${opp_trim//\//_}"
  echo "[gauntlet] vs $opp_trim ($MATCHES matches, workers=$EVAL_WORKERS)"

  if (( EVAL_WORKERS <= 1 || MATCHES <= 1 )); then
    CHECKPOINT="$CHECKPOINT" \
    MATCHES="$MATCHES" \
    BASE_SEED="$BASE_SEED" \
    PYTHON_BIN="$PYTHON_BIN" \
    OPPONENT_PROFILE="$opp_trim" \
    CPU_FRACTION="$CPU_FRACTION" \
    MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
    SCORENET_DEVICE="$SCORENET_DEVICE" \
    EVAL_DUPLICATE_DEALS="$EVAL_DUPLICATE_DEALS" \
    node "$EVAL_BUNDLE" | tee "$OUTPUT_DIR/${opp_safe}.json"
  else
    SHARD_DIR="$OUTPUT_DIR/${opp_safe}_shards"
    mkdir -p "$SHARD_DIR"
    BASE_MATCHES_PER_WORKER=$((MATCHES / EVAL_WORKERS))
    REMAINDER_MATCHES=$((MATCHES % EVAL_WORKERS))
    PIDS=()
    SHARD_FILES=()
    for ((w=0; w<EVAL_WORKERS; w++)); do
      SHARD_M="$BASE_MATCHES_PER_WORKER"
      if (( w < REMAINDER_MATCHES )); then SHARD_M=$((SHARD_M + 1)); fi
      if (( SHARD_M <= 0 )); then continue; fi
      # Force even shard size where possible so duplicate-dealing pairs stay within shard.
      if (( EVAL_DUPLICATE_DEALS == 1 )) && (( SHARD_M % 2 != 0 )) && (( SHARD_M > 1 )); then
        SHARD_M=$((SHARD_M - 1))
      fi
      SHARD_FILE="$SHARD_DIR/shard_${w}.json"
      SHARD_FILES+=("$SHARD_FILE")
      (
        CHECKPOINT="$CHECKPOINT" \
        MATCHES="$SHARD_M" \
        BASE_SEED="$((BASE_SEED + w * 1000))" \
        PYTHON_BIN="$PYTHON_BIN" \
        OPPONENT_PROFILE="$opp_trim" \
        CPU_FRACTION="$CPU_FRACTION" \
        MPS_MEMORY_FRACTION="$MPS_MEMORY_FRACTION" \
        SCORENET_DEVICE="$SCORENET_DEVICE" \
        EVAL_DUPLICATE_DEALS="$EVAL_DUPLICATE_DEALS" \
        node "$EVAL_BUNDLE" > "$SHARD_FILE"
      ) &
      PIDS+=("$!")
    done
    for pid in "${PIDS[@]}"; do wait "$pid"; done

    "$PYTHON_BIN" - "$OUTPUT_DIR/${opp_safe}.json" "${SHARD_FILES[@]}" <<'PY'
import json, sys
from pathlib import Path
out_path = Path(sys.argv[1])
files = [Path(p) for p in sys.argv[2:]]
agg = {
    "matches": 0,
    "checkpoint": None,
    "opponentProfile": None,
    "duplicateDeals": None,
    "learnedLevelGainTotal": 0,
    "legacyLevelGainTotal": 0,
    "learned": {"wins": 0, "winRate": 0.0, "averageLevelGainOnWins": 0.0},
    "legacy": {"wins": 0, "winRate": 0.0, "averageLevelGainOnWins": 0.0},
    "shards": [str(p) for p in files],
}
for p in files:
    d = json.loads(p.read_text())
    agg["matches"] += int(d.get("matches", 0))
    agg["learnedLevelGainTotal"] += int(d.get("learnedLevelGainTotal", 0))
    agg["legacyLevelGainTotal"] += int(d.get("legacyLevelGainTotal", 0))
    agg["learned"]["wins"] += int((d.get("learned") or {}).get("wins", 0))
    agg["legacy"]["wins"] += int((d.get("legacy") or {}).get("wins", 0))
    if agg["checkpoint"] is None: agg["checkpoint"] = d.get("checkpoint")
    if agg["opponentProfile"] is None: agg["opponentProfile"] = d.get("opponentProfile")
    if agg["duplicateDeals"] is None: agg["duplicateDeals"] = d.get("duplicateDeals")
m = max(agg["matches"], 1)
agg["netLevelDeltaFromLearnedPerspective"] = agg["learnedLevelGainTotal"] - agg["legacyLevelGainTotal"]
agg["netLevelDeltaPerMatch"] = agg["netLevelDeltaFromLearnedPerspective"] / m
agg["learned"]["winRate"] = agg["learned"]["wins"] / m
agg["legacy"]["winRate"] = agg["legacy"]["wins"] / m
agg["learned"]["averageLevelGainOnWins"] = (
    agg["learnedLevelGainTotal"] / agg["learned"]["wins"] if agg["learned"]["wins"] else 0.0
)
agg["legacy"]["averageLevelGainOnWins"] = (
    agg["legacyLevelGainTotal"] / agg["legacy"]["wins"] if agg["legacy"]["wins"] else 0.0
)
out_path.write_text(json.dumps(agg, indent=2) + "\n")
print(json.dumps(agg, indent=2))
PY
  fi
done

echo "[gauntlet] aggregating markdown report..."
"$PYTHON_BIN" training/scorenet/aggregate_gauntlet.py "$OUTPUT_DIR" --checkpoint "$CHECKPOINT" --output "$OUTPUT_DIR/README.md"
echo "[gauntlet] done. Report: $OUTPUT_DIR/README.md"

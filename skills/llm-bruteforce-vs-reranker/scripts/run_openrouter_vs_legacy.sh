#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  run_openrouter_vs_legacy.sh <openrouter-model-slug>

Optional env:
  MATCHES=20
  BASE_SEED=20430001
  OPENROUTER_TIMEOUT_MS=15000
  OPENROUTER_MAX_TOKENS=96
  OPENROUTER_OPPONENT_PROFILE=legacy-v1
  OPENROUTER_API_KEY=...

Example:
  ./skills/llm-bruteforce-vs-reranker/scripts/run_openrouter_vs_legacy.sh \
    deepseek/deepseek-chat-v3-0324
EOF
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODEL_SLUG="$1"
MATCHES="${MATCHES:-20}"
BASE_SEED="${BASE_SEED:-20430001}"
TIMEOUT_MS="${OPENROUTER_TIMEOUT_MS:-15000}"
MAX_TOKENS="${OPENROUTER_MAX_TOKENS:-96}"
OPPONENT_PROFILE="${OPENROUTER_OPPONENT_PROFILE:-legacy-v1}"
STRICT_REMOTE="${OPENROUTER_STRICT_REMOTE:-1}"
RUNNER_BUNDLE="/tmp/runHeadlessMatch.bundle.cjs"
STAMP="$(date +%Y%m%d-%H%M%S)"
SAFE_MODEL="$(printf '%s' "$MODEL_SLUG" | tr '/:.' '---')"
OUT_DIR="/tmp/llm-vs-legacy/${STAMP}-${SAFE_MODEL}"
OPENROUTER_JSON="$OUT_DIR/openrouter.json"
RERANKER_JSON="$OUT_DIR/llmreranker.json"

mkdir -p "$OUT_DIR"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  if [[ -f "$ROOT_DIR/apikey/key.rtf" ]]; then
    OPENROUTER_API_KEY="$(textutil -convert txt -stdout "$ROOT_DIR/apikey/key.rtf" | tr -d '\n\r')"
    export OPENROUTER_API_KEY
  else
    echo "Missing OPENROUTER_API_KEY and no $ROOT_DIR/apikey/key.rtf found." >&2
    exit 1
  fi
fi

cd "$ROOT_DIR"
npx esbuild src/arena/runHeadlessMatch.ts --bundle --platform=node --format=cjs --outfile="$RUNNER_BUNDLE" >/dev/null

run_mode() {
  local mode="$1"
  local outfile="$2"

  OPENROUTER_MODEL="$MODEL_SLUG" \
  OPENROUTER_AGENT_MODE="$mode" \
  OPENROUTER_OPPONENT_PROFILE="$OPPONENT_PROFILE" \
  OPENROUTER_STRICT_REMOTE="$STRICT_REMOTE" \
  MATCHES="$MATCHES" \
  BASE_SEED="$BASE_SEED" \
  OPENROUTER_TIMEOUT_MS="$TIMEOUT_MS" \
  OPENROUTER_MAX_TOKENS="$MAX_TOKENS" \
  node "$RUNNER_BUNDLE" >"$outfile"
}

run_mode openrouter "$OPENROUTER_JSON"
run_mode llmreranker "$RERANKER_JSON"

node - "$OPENROUTER_JSON" "$RERANKER_JSON" <<'EOF'
const fs = require('fs');

const [openrouterPath, rerankerPath] = process.argv.slice(2);
const openrouter = JSON.parse(fs.readFileSync(openrouterPath, 'utf8'));
const reranker = JSON.parse(fs.readFileSync(rerankerPath, 'utf8'));

function line(label, result) {
  const winRate = (result.summary.llmWinRate * 100).toFixed(1);
  return `${label}: ${result.summary.llmWins}/${result.matches} wins (${winRate}%)`;
}

console.log(line('openrouter', openrouter));
console.log(line('llmreranker', reranker));
console.log(`openrouter.json: ${openrouterPath}`);
console.log(`llmreranker.json: ${rerankerPath}`);
EOF

#!/usr/bin/env bash
# Append checkpoint paths to a prior manifest (one .pt per line) for hybrid self-play.
# Usage:
#   training/scorenet/init_prior_manifest.sh path/to/manifest.txt ckpt1.pt ckpt2.pt ...
# Example (after a run exists):
#   training/scorenet/init_prior_manifest.sh training/scorenet/checkpoints/my_run/prior_snapshots/manifest.txt \
#     training/scorenet/checkpoints/my_run/ppo_iter_020/ppo/epoch_048.pt \
#     training/scorenet/checkpoints/my_run/ppo_iter_040/ppo/epoch_048.pt
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo "usage: $0 MANIFEST.txt CKPT.pt [CKPT.pt ...]" >&2
  exit 1
fi

MANIFEST="$1"
shift
mkdir -p "$(dirname "$MANIFEST")"
touch "$MANIFEST"

for ck in "$@"; do
  if [[ ! -f "$ck" ]]; then
    echo "skip (not a file): $ck" >&2
    continue
  fi
  # normalize to repo-relative if under cwd
  echo "$ck" >> "$MANIFEST"
  echo "[init_prior_manifest] appended: $ck"
done

echo "[init_prior_manifest] manifest=$MANIFEST lines=$(grep -c . "$MANIFEST" || echo 0)"

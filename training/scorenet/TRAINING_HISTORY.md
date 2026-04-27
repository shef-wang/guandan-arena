# ScoreNet PPO / self-play – recent history (for restarts)

## PPO curriculum (authoritative, agreed)

1. **Milestone A — `legacy-v2.6`:** train PPO until eval win rate clears the
   v2.6 stop rule; snapshot (e.g. `milestones/v26_winner.pt`).
2. **Milestone B — `legacy-v3.0`:** continue from that checkpoint, train
   PPO **directly** against v3.0 (optional frozen-partner / pool settings
   as in `README.md`). There is **no** intermediate training milestone
   against **`legacy-v2.7`**.
3. **Later:** self-play vs frozen ScoreNet pool; **gauntlet** may still
   **evaluate** against v1, v2.6, v2.7, v3.0 for reporting — that is
   **evaluation only**, not a training stage between v2.6 and v3.0.

---

This file is also a **human log** of what was running in the “past few hours”
window around **2026-04-25 → 2026-04-26** (local machine time) so the next
session can continue without re-discovering state.

## What was running (duplicates)

Several **`training/scorenet/selfplay_loop.sh`** jobs were started **in parallel** (should normally be one at a time). All targeted **`OPPONENT_PROFILE=legacy-v2.6`**, with `ROLLOUT_WORKERS=8`, `ROLLOUT_MATCHES=300`, and checkpoints under different roots:

| Approx. purpose (from env) | `CHECKPOINT_ROOT` (under `/tmp`) | Notes |
|----------------------------|----------------------------------|--------|
| Long / curriculum-style | `scorenet_v26_training_long` | `INIT` from v1 long run: `.../v1_training_long/ppo_iter_026/...` (example) |
| Fast eval, 20-game | `scorenet_v26_training_eval20` | `INIT` e.g. `v26_training_long/ppo_iter_011/...` |
| 40-game eval | `scorenet_v26_training_eval40` | `SCORENET_DEVICE=cpu` in the captured command; `INIT` e.g. `v26_training_eval20/ppo_iter_003/...` |
| 40-game + **MPS** | `scorenet_v26_training_eval40_gpu` | `SCORENET_DEVICE=mps` |

Typical process fan-out per loop: **8×** `node /tmp/scorenet_export_ppo.cjs` + **8×** `Python training/scorenet/serve_policy.py` (rollout), plus `bash` driver. At one point, **~13** `selfplay_loop` instances and **~22** `export_ppo.cjs` processes existed (wasteful overlap).

## One run (eval40 GPU) – concrete outcome

For log **`/tmp/scorenet_v26_train_eval40_gpu_20260425_232643.log`** (and matching `CHECKPOINT_ROOT=/tmp/scorenet_v26_training_eval40_gpu`):

- Drove to **PPO iteration 8** / `100000`.
- Eval (40 matches, `legacy-v2.6`) reported **learned win rate 0.675** and triggered **early stop** (`winRate > 0.65`, `net` gate effectively disabled with `STOP_MIN_NET_DELTA=-999`).
- The shell then hit **`selfplay_loop.sh: line 403: syntax error near unexpected token \`eval_path.read_text'** – so the driver **did not finish cleanly** after the stop condition; logs/JSON near that line may be mangled.
- A **separate 60s “heartbeat”** process kept appending to the same log even after the main script error, so “heartbeat: training still running” is **not** proof that PPO was still making progress.

**Checkpoint path from that run (example, iter 8 end):**  
`/tmp/scorenet_v26_training_eval40_gpu/ppo_iter_008/ppo/epoch_014.pt` (verify on disk; iteration dirs may go past 008 on other machines.)

## Stale heartbeats

An old **v1**-related monitor was still looping: e.g. zsh with  
`LOG_PATH="/tmp/scorenet_v1_train_20260425_160541.log"` and `monitor-heartbeat: training still running` – not the same as the v2.6 PPO job.

## Dev server (not offline training)

A **`serve_policy.py`** with **`--device mps`** was tied to the **Vite** session (in-repo checkpoint under `training/scorenet/checkpoints/.../run_20260425_pipeline_main/...`). That is for **browser** inference, not the same as `/tmp/...` offline loops.

## Cleanup (2026-04-26)

All duplicate offline training was **force-stopped** (`SIGKILL` to `export_ppo.cjs`, `selfplay_loop.sh`, `serve_policy.py` under training, and scorenet v26 training launchers; plus orphan heartbeats). **Restart `npm run dev` if the UI policy server was also killed.**

## Next restart – suggested discipline

1. **One** `selfplay_loop.sh` at a time; do not stack Cursor terminals with the same recipe.
2. **Fix** `selfplay_loop.sh` around **line 403** (post-eval / stop path) so early exit is clean and JSON logs do not break bash.
3. After a “stop” in Activity Monitor, confirm **no** `selfplay_loop`, `export_ppo.cjs`, or extra `serve_policy` remain.
4. If resuming, pick the **intended** `INIT_CHECKPOINT` and `CHECKPOINT_ROOT` and document them in a one-line **shell export block** in chat or in this file.

---
*Last updated: 2026-04-26 (session cleanup + log consolidation).*

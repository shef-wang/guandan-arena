# Guandan Arena

An open-source playground for watching and playing against different kinds of Guandan (掼蛋) AI in your browser.

The pitch: most existing Guandan AI work is either a research codebase with no UI, or a closed product with no model access. This repo is a small middle ground — a browser-based table where you can sit chat-LLMs (DeepSeek, Kimi, Gemma), a small zero-style PPO model, and rule-based heuristics at the same four-player table, watch them play each other, or play against any of them yourself.

**Live demo (no install):** [guandan-arena-sigma.vercel.app](https://guandan-arena-sigma.vercel.app/)

## What you can do here

- **Play one click in your browser** against rule-based heuristics or any of several mainstream chat-LLMs (DeepSeek V3, Kimi K2.6, Gemma 4 26B), via OpenRouter.
- **Watch a 4-AI arena** where you mix and match seats — a chat-LLM here, a heuristic there, a learned policy in the other corner — and observe how they interact across full games.
- **Run the project locally** to also play against a small PPO-trained policy network (`ScoreNet`) checked into the repo.

The "play against an LLM" and "watch LLM vs zero-style RL vs rule-based" comparisons are, as far as I know, not available anywhere else in this game.

## What works where


| Feature                                       | Live Vercel demo | Local (`npm run dev`)           |
| --------------------------------------------- | ---------------- | ------------------------------- |
| Game engine + browser UI                      | yes              | yes                             |
| Heuristic bots (legacy-v1, legacy-v3)         | yes              | yes                             |
| Chat-LLMs via OpenRouter (you supply the key) | yes              | yes                             |
| 4-AI arena with mix-and-match seats           | yes              | yes                             |
| ScoreNet PPO policy in the browser            | yes (ONNX)       | yes (ONNX)                      |
| Multiplayer (humans vs humans)                | no               | yes (with `npm run server:dev`) |


The PPO model is exported to ONNX (`public/scorenet/scorenet.onnx`, ~1.3 MB) and runs on `onnxruntime-web`, so the same learned policy plays in the static Vercel build as well as locally — no Python server needed at runtime. The bundled checkpoint is `training/scorenet/checkpoints/stability_v3_20260503_180902/ppo_iter_080/ppo/epoch_010.pt`; rerun `python training/scorenet/export_onnx.py` after training to refresh it.

## Prior art and acknowledgements

This project is not the first or strongest Guandan AI. It exists alongside several pieces of serious prior work, and is meant to complement rather than replace them:

- **[DanZero](https://arxiv.org/abs/2210.17087)** (Lu et al., AAAI 2023) and **[DanZero+](https://arxiv.org/abs/2312.02561)** — the foundational reinforcement learning work for Guandan. Distributed Deep Monte Carlo training, hand-crafted features. Code at [submit-paper/Danzero_plus](https://github.com/submit-paper/Danzero_plus). Not packaged for direct browser play, no released ready-to-run weights from the original authors.
- **[DanLM](https://github.com/dashidhy/DanLM)** (released March 2026) — a feature-free TinyLM Transformer for Guandan trained with DMC self-play, with open weights, a local web UI, and a reproduced/improved DanZero baseline bundled in. Currently #2 on the [Botzone GuanDan leaderboard](https://en.botzone.org.cn/game/ranklist/65490c16ec1ab1389702dced) and beats the strongest competition baselines at 80%+ win rates. As a "play against a learned Guandan model" experience, DanLM is more rigorously evaluated than the policy in this repo and worth checking out.
- **[OpenGuanDan](https://github.com/GameAI-NJUPT/OpenGuanDan)** — a Guandan benchmark and simulation environment built for AI research, with a WebSocket protocol layer.

If you want the strongest open-source Guandan-only model, look at DanLM. If you want to compare chat-LLMs, learned policies, and heuristics in the same UI, this repo is the easier starting point.

## What's in the repo

### Game engine and browser UI

A TypeScript Guandan implementation (rules, legal-action generation, state transitions, match resolution) and a React/Vite frontend.

- `src/game/rules.ts`, `src/game/state.ts`, `src/game/cards.ts`, `src/game/types.ts`
- `src/App.tsx`, `src/PracticeTable.tsx`, `src/table/GameTableScene.tsx`

### Arena infrastructure

A four-seat arena that supports mixing different agent types in the same match, with a spectator UI for watching them play.

- `src/arena/spectatorConfig.ts`, `src/arena/spectatorMatch.ts`, `src/arena/ArenaSpectator.tsx`
- `src/arena/openrouter.ts` — chat-LLM seat agents
- `src/arena/scoreNetSeatAgent.ts` — PPO policy seat agent (in-browser via ONNX)
- `src/arena/scoreNetBrowserSession.ts` — lazy ONNX session loader for the browser
- `src/arena/runHeadlessMatch.ts`, `src/arena/runBuiltinTournament.ts` — CLI tournament runners

### Heuristic agent ladder

Rule-based agents of progressively increasing strength, used both as in-game opponents and as a teacher curriculum for training the PPO model. Built incrementally with help from Claude Opus.

- `src/game/ai.ts` — `legacy-v1` (clean rule-based), several `legacy-v2.x` iterations, `legacy-v3.0` (top-K candidates plus multi-policy Monte Carlo rollouts to terminal)

### ScoreNet training stack

A small attention-based policy and value network, trained with imitation warm-start on `legacy-v1` followed by PPO with GAE. Self-play uses a heuristic-mixed curriculum rather than pure self-play.

- `training/scorenet/scorenet.py`, `training/scorenet/train_imitation.py`, `training/scorenet/train_ppo.py`
- `training/scorenet/run_selfplay.sh`, `training/scorenet/selfplay_loop.sh`
- `training/scorenet/serve_policy.py` — stdin/stdout inference server used by the headless evaluation/benchmark CLIs
- `training/scorenet/export_onnx.py` — exports the production PyTorch checkpoint to `public/scorenet/scorenet.onnx` for browser inference, with a torch ↔ onnxruntime parity check
- `training/scorenet/checkpoints/stability_v3_20260503_180902/ppo_iter_080/ppo/epoch_010.pt` — the production checkpoint, tracked in the repo so it's reproducible

### Multiplayer server

A Node + WebSocket server for human-vs-human play locally.

- `server/index.ts`

## Honest evaluation status

Against the strongest in-repo heuristic (`legacy-v3.0`), the current ScoreNet checkpoint achieves ~42% single-seat and ~26% pair-level win rate (see `[training/scorenet/checkpoints/stability_v3_20260503_180902/ppo_iter_080/eval_summary.json](training/scorenet/checkpoints/stability_v3_20260503_180902/ppo_iter_080/eval_summary.json)`). It is fun to play against but does not yet beat the strongest heuristic teacher, and has not been benchmarked against external bots like Botzone competition entries.

The methodology bet — using a hand-built heuristic curriculum as a PPO teacher — differs from DanLM's pure self-play DMC. Whether this curriculum approach can close the gap with stronger pure self-play setups is something I'd like to find out.

## Running locally

You need Node 18+ to run and play. Python (3.11+ with PyTorch) is only needed if you want to retrain or re-export the PPO model.

```bash
npm install
npm run dev
```

That's it — the PPO model loads in the browser via ONNX. To re-export the model after training, set up the Python env once:

```bash
python -m venv .venv-danzero
source .venv-danzero/bin/activate
pip install -r training/scorenet/requirements.txt
pip install onnx onnxruntime onnxscript
python training/scorenet/export_onnx.py
```

To play against chat-LLMs, supply an OpenRouter API key in the Practice or Arena setup screen. You can also drop the key into `apikey/key` (gitignored) and it will be picked up automatically in dev.

For the multiplayer server:

```bash
npm run server:dev
```

For headless arena tournaments:

```bash
npm run arena:headless
```

## What's next

- **An LLM-vs-LLM Guandan leaderboard.** The most novel piece in this repo is the ability to seat several chat-LLMs at the same table. The natural next step is a public leaderboard with cost-per-game, latency, and head-to-head win rates across DeepSeek, Qwen, Kimi, GPT, Claude, Gemma, and others. The question I most want to answer: do Chinese-trained LLMs play this Chinese cultural game better than Western ones? Funding the inference is the open problem.
- **Continue training the PPO model** to see how far the heuristic-curriculum approach can be pushed.

## Contributing and contact

Suggestions, sponsorship ideas for the LLM arena inference, methodology critiques, and pull requests are all welcome — open an issue or reach out.

## License

No license file is included yet. If you want to use any of this code or the trained checkpoint outside of personal evaluation, please open an issue first.
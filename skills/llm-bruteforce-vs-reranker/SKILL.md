---
name: llm-bruteforce-vs-reranker
description: Use when benchmarking an OpenRouter model in this repo against legacy-v1 in two modes: direct LLM bruteforce (`openrouter`) and `llmreranker`. Covers the exact local workflow for running 20-game head-to-head batches, keeping seeds aligned, and comparing win rate between the two modes for different model slugs.
---

# LLM Bruteforce vs Reranker

Use this skill when you want a repeatable comparison of:

- direct LLM play vs `legacy-v1`
- `llmreranker` vs `legacy-v1`

for one or more OpenRouter model slugs.

## Workflow

1. Run [scripts/run_openrouter_vs_legacy.sh](scripts/run_openrouter_vs_legacy.sh) with a model slug.
2. Keep the same `MATCHES` and `BASE_SEED` across both modes so the comparison is fair.
3. Read the two JSON outputs and compare:
   - `summary.llmWins`
   - `summary.legacyWins`
   - `summary.llmWinRate`
   - `matchResults`

## Default Command

```bash
./skills/llm-bruteforce-vs-reranker/scripts/run_openrouter_vs_legacy.sh \
  deepseek/deepseek-chat-v3-0324
```

This runs:

- `OPENROUTER_AGENT_MODE=openrouter`
- `OPENROUTER_AGENT_MODE=llmreranker`

against `OPENROUTER_OPPONENT_PROFILE=legacy-v1`, with the same seed range.

## Inputs

- Positional arg 1: OpenRouter model slug, for example:
  - `deepseek/deepseek-chat-v3-0324`
  - `google/gemini-2.5-flash`
  - `minimax/minimax-m2.7`
  - `openai/gpt-oss-120b`
- Optional env:
  - `MATCHES` default `20`
  - `BASE_SEED` default `20430001`
  - `OPENROUTER_TIMEOUT_MS` default `15000`
  - `OPENROUTER_OPPONENT_PROFILE` default `legacy-v1`
  - `OPENROUTER_API_KEY` if you do not want to read from `apikey/key.rtf`

## Outputs

The script writes JSON files under `/tmp/llm-vs-legacy/<timestamp>-<model>/`:

- `openrouter.json`
- `llmreranker.json`

It also prints a short console summary with both win rates.

## Notes

- The benchmark runner bundles `src/arena/runHeadlessMatch.ts` to a temporary Node bundle before running. This avoids depending on stale generated runner files.
- The LLM team is seats `0` and `2`; the opponent team is the selected builtin profile, usually `legacy-v1`.
- If you are comparing multiple models, run the script once per model and keep `MATCHES` and `BASE_SEED` consistent.
- If OpenRouter rate limits or provider issues show up, retry later or increase `OPENROUTER_TIMEOUT_MS`.

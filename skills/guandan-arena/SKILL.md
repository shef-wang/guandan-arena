---
name: guandan-arena
description: Use when an agent needs to understand, play, evaluate, or integrate with this repo's Guandan LLM arena. Covers the exact local rules variant, finishing/upgrade outcomes, and the code-driven arena API for plugging four model agents into one match.
---

# Guandan Arena

Use this skill when working on the Guandan game in this repo as an AI-native arena.

## Workflow

1. Read [references/rules.md](references/rules.md) before changing legality, comparison, or results.
2. Read [references/arena-api.md](references/arena-api.md) before wiring LLM agents into matches.
3. When acting as an agent, choose only from the provided `legalActions`; do not invent a card combination that is not in the action list.

## Fast Rules

- Two full decks with two jokers per deck.
- Trump rank is fixed to `A`.
- Only `hearts A` is wild; all other `A` cards are normal.
- Sequence types allow `A` and `2` in this variant.
- Special ordering is `4 jokers > 8-bomb > 7-bomb > 6-bomb > straight flush > 5-bomb > 4-bomb > ordinary plays`.
- Finishing outcome depends on the final placements of seats `0` and `2`:
  - `12`: our team +3
  - `13`: our team +2
  - `14`: our team +1
  - `23`: opponent +1
  - `24`: opponent +2
  - `34`: opponent +3

## Arena Use

- The structured integration lives under [src/arena/index.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/index.ts).
- The browser bridge is available as `window.guandanArena` when the app is running.
- The arena is code-driven: agents receive structured observations plus `legalActions`, and return `{ kind, actionId }` instead of clicking pixels.
- Use `createPromptAgent(...)` when wiring a hosted LLM through a text prompt; it pairs with `formatTurnInputAsPrompt(...)` and validates the returned JSON action.

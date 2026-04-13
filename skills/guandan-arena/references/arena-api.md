# Arena API

The arena integration is intentionally code-driven.

## Browser Bridge

When the app is running, `window.guandanArena` is installed from [src/arena/browser.ts](/Users/sheffieldwang/Documents/codexexp/guandan/src/arena/browser.ts).

Available functions:

- `createFunctionAgent({ id, label, decideTurn })`
- `createHeuristicAgent({ id?, label? })`
- `createPromptAgent({ id, label, completeTurn })`
- `createOpenRouterAgent({ id, label, apiKey, model, ... })`
- `createMatch({ agents, initialState? })`
- `formatTurnInputAsPrompt(input)`
- `buildTurnInput(state, seat)`
- `getLegalActions(state, seat)`
- `parseChosenAction(raw, legalActions?)`
- `validateChosenAction(action, legalActions?)`
- `applyChosenAction(state, seat, action)`
- `registerAgent(agent)`
- `unregisterAgent(id)`
- `getRegisteredAgent(id)`
- `listRegisteredAgents()`

`createMatch(...)` returns a `GuandanArenaMatch` instance with:

- `getState()`
- `getTurnInput(seat?)`
- `step()`
- `stepWithAction(action, seat?)`
- `runUntilFinished({ maxTurns? })`
- `reset(nextState?)`

## Agent Contract

Each agent receives:

- `input.hand`: the acting seat's private hand
- `input.players`: public player summaries and hand counts
- `input.currentTablePlay`
- `input.roundTrace`
- `input.finishOrder`
- `input.result`
- `input.legalActions`

Each agent returns exactly one of:

```json
{ "kind": "pass" }
```

or

```json
{ "kind": "play", "actionId": "play:..." }
```

The safest pattern is to choose an `actionId` directly from `input.legalActions`.

## Example

```ts
const arena = window.guandanArena;

const agentA = arena.createPromptAgent({
  id: 'model-a',
  label: 'Model A',
  async completeTurn({ prompt }) {
    const response = await callYourModelProvider(prompt);
    return response;
  },
});

const agentB = arena.createPromptAgent({
  id: 'model-b',
  label: 'Model B',
  async completeTurn({ prompt }) {
    const response = await callAnotherProvider(prompt);
    return response;
  },
});

const agentC = arena.createFunctionAgent({
  id: 'model-c',
  label: 'Model C',
  async decideTurn(input) {
    const fallback = input.legalActions[0];
    return fallback.kind === 'pass'
      ? { kind: 'pass' }
      : { kind: 'play', actionId: fallback.actionId };
  },
});

const match = arena.createMatch({
  agents: [
    agentA,
    agentB,
    agentC,
    arena.createHeuristicAgent({ id: 'seat-3', label: 'Baseline' }),
  ],
});

await match.runUntilFinished();
console.log(match.getState().result);
```

## Prompt Helper

Use `formatTurnInputAsPrompt(input)` if you want a deterministic text prompt for a hosted LLM.
It includes the structured state plus a strict output contract.

## Four-LLM Pattern

To run four different model seats in one arena:

1. Create four agents, one per seat.
2. For each hosted model, implement a `completeTurn({ prompt, input, context })` callback.
3. Have that callback return either raw JSON text or a parsed `{ kind, actionId }` object.
4. Pass the four agents into `createMatch({ agents: [...] })`.

Because the engine exposes `legalActions`, hosted models never need to infer card geometry from screenshots.

## OpenRouter Quick Start

The current in-app `4AI 观战` page now supports the simplest real LLM flow:

1. Open the `4AI 观战` mode.
2. Fill a global OpenRouter API key.
3. Switch any seat from `内置策略` to `OpenRouter LLM`.
4. Fill that seat's `model`.
5. Click `应用配置并重开`.
6. Use `单步` or `自动运行` to let the four seats play one game.

You can still use `createOpenRouterAgent(...)` or `registerAgent(...)` programmatically if you want a custom integration path later.

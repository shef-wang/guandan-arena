// Stress test: run many full Guandan matches where every AI seat picks a
// random index from the legal-action list returned by buildArenaTurnInput,
// and assert applyArenaChosenAction never produces an illegal play. Also
// asserts the new defensive applyPlay guard never fires (which would mean
// somewhere in the engine an illegal play slipped past the legal-action list).
//
// Run:
//   npx esbuild tools/legality_smoke_test.ts --bundle --platform=node --format=cjs --outfile=/tmp/legality.cjs && node /tmp/legality.cjs

import { applyArenaChosenAction, buildArenaTurnInput } from '../src/arena/engine';
import { createNewGame } from '../src/game/state';
import type { GameState, Seat } from '../src/game/types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOneMatch(seed: number, maxTurns = 4000): { turns: number; finished: boolean } {
  const rng = mulberry32(seed);
  let state: GameState = createNewGame(rng);
  let turns = 0;

  while (!state.result && turns < maxTurns) {
    const seat = state.currentPlayer as Seat;
    const input = buildArenaTurnInput(state, seat);
    if (input.legalActions.length === 0) {
      throw new Error(`seed=${seed} turn=${turns}: no legal actions for seat ${seat}, tablePlay=${state.tablePlay?.play.label ?? 'null'}`);
    }
    const idx = Math.floor(rng() * input.legalActions.length);
    const chosen = input.legalActions[idx];
    const action = chosen.kind === 'pass' ? { kind: 'pass' as const } : { kind: 'play' as const, actionId: chosen.actionId };
    state = applyArenaChosenAction(state, seat, action);
    turns += 1;
  }

  return { turns, finished: state.result !== null };
}

const NUM_MATCHES = 200;
let totalTurns = 0;
let finishedCount = 0;
const startedAt = Date.now();

for (let i = 0; i < NUM_MATCHES; i += 1) {
  try {
    const result = runOneMatch(i + 1);
    totalTurns += result.turns;
    if (result.finished) finishedCount += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Match seed=${i + 1} failed: ${message}`);
    process.exit(1);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
console.log(`✅ ${NUM_MATCHES} matches completed without an illegal play.`);
console.log(`   total turns: ${totalTurns}, finished: ${finishedCount}/${NUM_MATCHES}, ${elapsed}s`);

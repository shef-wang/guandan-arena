import { readFileSync } from 'node:fs';
import { chooseAiAction, rankLegacyV1ActionCandidates } from '../src/game/ai';
import { createSeededRandom } from '../src/game/cards';
import { createNewGame } from '../src/game/state';
import { applyArenaChosenAction } from '../src/arena/engine';
import type { Seat } from '../src/game/types';
import type { ArenaChosenAction } from '../src/arena/types';

interface TracedMatchResult {
  baseSeed: number | null;
  llmTeam: {
    seats: Seat[];
  };
  matchResults: Array<{
    seed: number | null;
  }>;
  actionHistory?: Array<{
    turn: number;
    seat: Seat;
    actor: string;
    action: string;
    actionId: string;
    play: {
      key: string;
      label: string;
      type: string;
      cards: string[];
    } | null;
  }>;
}

interface DeviationExample {
  turn: number;
  seat: Seat;
  actor: string;
  actualAction: string;
  legacyTopAction: string;
  actualRank: number | null;
  totalCandidates: number;
}

const inputPath = process.argv[2];

if (!inputPath) {
  throw new Error('Usage: node analyzeRerankerDeviation.ts <trace-json>');
}

const result = JSON.parse(readFileSync(inputPath, 'utf8')) as TracedMatchResult;
if (!result.actionHistory || result.actionHistory.length === 0) {
  throw new Error('Trace JSON is missing actionHistory. Re-run with OUTPUT_TRACE=1.');
}

const seed = result.matchResults[0]?.seed ?? result.baseSeed;
const initialRandom = seed === null ? undefined : createSeededRandom(seed);
let state = createNewGame(initialRandom);

let llmTurns = 0;
let sameAsLegacyTop = 0;
let deviatedFromLegacyTop = 0;
let chosenRankSum = 0;
const deviationExamples: DeviationExample[] = [];

for (const entry of result.actionHistory) {
  const actualAction = toArenaChosenAction(entry.actionId);
  const isLlmTurn = result.llmTeam.seats.includes(entry.seat);

  if (isLlmTurn) {
    llmTurns += 1;

    const ranked = rankLegacyV1ActionCandidates(state, entry.seat);
    const legacyFallback = toArenaChosenActionFromDecision(chooseAiAction(state, entry.seat, 'legacy-v1'));
    const topKey = candidateKey(ranked[0]);
    const actualKey = actionKey(actualAction);
    const actualRank = ranked.findIndex((candidate) => candidateKey(candidate) === actualKey);
    const legacyTopAction = legacyFallback.kind === 'pass' ? 'pass' : legacyFallback.actionId;

    if (actualRank >= 0) {
      chosenRankSum += actualRank + 1;
    }

    if (actualKey === topKey) {
      sameAsLegacyTop += 1;
    } else {
      deviatedFromLegacyTop += 1;
      if (deviationExamples.length < 8) {
        deviationExamples.push({
          turn: entry.turn,
          seat: entry.seat,
          actor: entry.actor,
          actualAction: actualAction.kind === 'pass' ? 'pass' : actualAction.actionId,
          legacyTopAction,
          actualRank: actualRank >= 0 ? actualRank + 1 : null,
          totalCandidates: ranked.length,
        });
      }
    }
  }

  state = applyArenaChosenAction(state, entry.seat, actualAction);
}

console.log(
  JSON.stringify(
    {
      tracePath: inputPath,
      llmTurns,
      sameAsLegacyTop,
      deviatedFromLegacyTop,
      deviationRate: llmTurns > 0 ? deviatedFromLegacyTop / llmTurns : 0,
      averageChosenRank: llmTurns > 0 ? chosenRankSum / llmTurns : null,
      examples: deviationExamples,
    },
    null,
    2,
  ),
);

function toArenaChosenAction(actionId: string): ArenaChosenAction {
  if (actionId === 'pass') {
    return { kind: 'pass' };
  }

  return {
    kind: 'play',
    actionId,
  };
}

function toArenaChosenActionFromDecision(decision: ReturnType<typeof chooseAiAction>): ArenaChosenAction {
  if (decision.type === 'pass' || !decision.play) {
    return { kind: 'pass' };
  }

  return {
    kind: 'play',
    actionId: `play:${decision.play.key}`,
  };
}

function candidateKey(candidate: ReturnType<typeof rankLegacyV1ActionCandidates>[number] | undefined): string | null {
  if (!candidate) {
    return null;
  }

  if (candidate.type === 'pass') {
    return 'pass';
  }

  return candidate.play ? `play:${candidate.play.key}` : null;
}

function actionKey(action: ArenaChosenAction): string {
  return action.kind === 'pass' ? 'pass' : action.actionId;
}

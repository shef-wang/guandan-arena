declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildArenaTurnInput } from '../../src/arena/engine';
import { createSeededRandom } from '../../src/game/cards';
import { chooseLegacyV1AiAction } from '../../src/game/ai';
import { applyPass, applyPlay, createNewGame } from '../../src/game/state';
import type { AiDecision, GameState, Seat } from '../../src/game/types';
import { buildHeuristicContext, encodeTurnForPolicy } from './feature_codec';

interface PendingStep {
  team: 0 | 1;
  stateFeatures: number[];
  actionFeatures: number[][];
  targetActionIndex: number;
}

interface ImitationSample {
  state_features: number[];
  action_features: number[][];
  target_action_index: number;
  target_value: number;
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '5000');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260416');
  const trainPath = process.env.TRAIN_OUTPUT_PATH ?? 'training/scorenet/data/imitation_train.jsonl';
  const validPath = process.env.VALID_OUTPUT_PATH ?? 'training/scorenet/data/imitation_valid.jsonl';
  const validRatio = Number(process.env.VALID_RATIO ?? '0.1');

  mkdirSync(dirname(trainPath), { recursive: true });
  mkdirSync(dirname(validPath), { recursive: true });

  const trainLines: string[] = [];
  const validLines: string[] = [];
  let totalTurns = 0;

  for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
    const random = createSeededRandom(baseSeed + matchIndex);
    let state = createNewGame(random);
    const pending: PendingStep[] = [];
    let turnCount = 0;

    while (!state.result) {
      const seat = state.currentPlayer;
      const input = buildArenaTurnInput(state, seat);
      const decision = chooseLegacyV1AiAction(state, seat);
      const targetActionIndex = resolveTargetActionIndex(input.legalActions, decision);
      const heuristic = buildHeuristicContext(state, seat);
      const encoded = encodeTurnForPolicy(input, heuristic);

      pending.push({
        team: state.players[seat].team,
        stateFeatures: encoded.stateFeatures,
        actionFeatures: encoded.actionFeatures,
        targetActionIndex,
      });

      state = applyDecision(state, seat, decision);
      turnCount += 1;
    }

    totalTurns += turnCount;
    appendMatchSamples(pending, state, trainLines, validLines, validRatio, matchIndex);
  }

  writeFileSync(trainPath, `${trainLines.join('\n')}\n`, 'utf8');
  writeFileSync(validPath, `${validLines.join('\n')}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        matches,
        baseSeed,
        trainPath,
        validPath,
        trainSamples: trainLines.length,
        validSamples: validLines.length,
        averageTurnsPerMatch: matches > 0 ? totalTurns / matches : 0,
      },
      null,
      2,
    ),
  );
}

function appendMatchSamples(
  pending: PendingStep[],
  terminalState: GameState,
  trainLines: string[],
  validLines: string[],
  validRatio: number,
  matchIndex: number,
): void {
  if (!terminalState.result) {
    return;
  }

  for (const step of pending) {
    const value = terminalState.result.winnerTeam === step.team ? terminalState.result.levelDelta : -terminalState.result.levelDelta;
    const sample: ImitationSample = {
      state_features: step.stateFeatures,
      action_features: step.actionFeatures,
      target_action_index: step.targetActionIndex,
      target_value: value,
    };

    const destination = (matchIndex * 997 + step.targetActionIndex) % 100 < validRatio * 100 ? validLines : trainLines;
    destination.push(JSON.stringify(sample));
  }
}

function resolveTargetActionIndex(
  legalActions: Array<{ kind: 'play' | 'pass'; actionId: string }>,
  decision: AiDecision,
): number {
  if (decision.type === 'pass') {
    const index = legalActions.findIndex((action) => action.kind === 'pass');
    return index >= 0 ? index : 0;
  }

  const actionId = `play:${decision.play!.key}`;
  const index = legalActions.findIndex((action) => action.actionId === actionId);
  return index >= 0 ? index : 0;
}

function applyDecision(state: GameState, seat: Seat, decision: AiDecision): GameState {
  if (decision.type === 'pass') {
    return applyPass(state, seat);
  }
  return applyPlay(state, seat, decision.play!);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

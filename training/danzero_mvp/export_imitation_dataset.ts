declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chooseAiAction, type AiProfile } from '../../src/game/ai';
import { createSeededRandom } from '../../src/game/cards';
import { createNewGame } from '../../src/game/state';
import { buildArenaTurnInput, applyArenaChosenAction } from '../../src/arena/engine';
import type { ArenaChosenAction } from '../../src/arena/types';
import { encodeTurnForPolicy } from './feature_codec';

interface SerializedSample {
  state_features: number[];
  action_features: number[][];
  target_action_index: number;
  target_value: number;
}

interface PendingSample {
  team: 0 | 1;
  encoded: ReturnType<typeof encodeTurnForPolicy>;
  targetActionIndex: number;
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '160');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260413');
  const teacherProfile = (process.env.TEACHER_PROFILE ?? 'legacy-v1') as AiProfile;
  const outputPath = process.env.OUTPUT_PATH ?? 'training/danzero_mvp/data/legacy_train.jsonl';
  const lines: string[] = [];

  mkdirSync(dirname(outputPath), { recursive: true });

  for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
    const random = createSeededRandom(baseSeed + matchIndex);
    let state = createNewGame(random);
    const pending: PendingSample[] = [];

    while (!state.result) {
      const seat = state.currentPlayer;
      const input = buildArenaTurnInput(state, seat);
      const decision = chooseAiAction(state, seat, teacherProfile);
      const chosenAction = toArenaChosenAction(decision);
      const targetActionIndex = input.legalActions.findIndex((action) =>
        chosenAction.kind === 'pass' ? action.kind === 'pass' : action.kind === 'play' && action.actionId === chosenAction.actionId,
      );

      if (targetActionIndex === -1) {
        throw new Error(`Unable to locate target action for match ${matchIndex + 1}, seat ${seat}.`);
      }

      pending.push({
        team: state.players[seat].team,
        encoded: encodeTurnForPolicy(input),
        targetActionIndex,
      });

      state = applyArenaChosenAction(state, seat, chosenAction);
    }

    if (!state.result) {
      throw new Error(`Match ${matchIndex + 1} ended without a terminal result.`);
    }

    for (const sample of pending) {
      const signedValue = sample.team === state.result.winnerTeam ? state.result.levelDelta : -state.result.levelDelta;
      const serialized: SerializedSample = {
        state_features: sample.encoded.stateFeatures,
        action_features: sample.encoded.actionFeatures,
        target_action_index: sample.targetActionIndex,
        target_value: signedValue,
      };
      lines.push(JSON.stringify(serialized));
    }
  }

  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        matches,
        baseSeed,
        teacherProfile,
        outputPath,
        sampleCount: lines.length,
      },
      null,
      2,
    ),
  );
}

function toArenaChosenAction(decision: ReturnType<typeof chooseAiAction>): ArenaChosenAction {
  if (decision.type === 'pass' || !decision.play) {
    return { kind: 'pass' };
  }

  return {
    kind: 'play',
    actionId: `play:${decision.play.key}`,
  };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

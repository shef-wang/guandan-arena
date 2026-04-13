declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { createHeuristicAgent, GuandanArenaMatch } from './engine';
import { createSeededRandom } from '../game/cards';
import { createNewGame } from '../game/state';

interface MatchSummary {
  index: number;
  balancedTeam: 0 | 1;
  winnerTeam: 0 | 1;
  levelDelta: 1 | 2 | 3;
  placementKey: string;
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '20');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260413');
  const summaries: MatchSummary[] = [];
  let balancedWins = 0;
  let legacyWins = 0;
  let balancedLevelGain = 0;
  let legacyLevelGain = 0;

  for (let index = 0; index < matches; index += 1) {
    const balancedTeam = (index % 2 === 0 ? 0 : 1) as 0 | 1;
    const random = createSeededRandom(baseSeed + index);
    const match = new GuandanArenaMatch({
      initialState: createNewGame(random),
      agents:
        balancedTeam === 0
          ? [
              createHeuristicAgent({ id: `balanced-${index}-0`, label: 'Balanced 0', profile: 'balanced-v2' }),
              createHeuristicAgent({ id: `legacy-${index}-1`, label: 'Legacy 1', profile: 'legacy-v1' }),
              createHeuristicAgent({ id: `balanced-${index}-2`, label: 'Balanced 2', profile: 'balanced-v2' }),
              createHeuristicAgent({ id: `legacy-${index}-3`, label: 'Legacy 3', profile: 'legacy-v1' }),
            ]
          : [
              createHeuristicAgent({ id: `legacy-${index}-0`, label: 'Legacy 0', profile: 'legacy-v1' }),
              createHeuristicAgent({ id: `balanced-${index}-1`, label: 'Balanced 1', profile: 'balanced-v2' }),
              createHeuristicAgent({ id: `legacy-${index}-2`, label: 'Legacy 2', profile: 'legacy-v1' }),
              createHeuristicAgent({ id: `balanced-${index}-3`, label: 'Balanced 3', profile: 'balanced-v2' }),
            ],
    });

    const state = await match.runUntilFinished({ maxTurns: 500 });
    if (!state.result) {
      throw new Error(`Match ${index + 1} finished without a result.`);
    }

    const winnerTeam = state.result.winnerTeam;
    summaries.push({
      index: index + 1,
      balancedTeam,
      winnerTeam,
      levelDelta: state.result.levelDelta,
      placementKey: state.result.placementKey,
    });

    if (winnerTeam === balancedTeam) {
      balancedWins += 1;
      balancedLevelGain += state.result.levelDelta;
    } else {
      legacyWins += 1;
      legacyLevelGain += state.result.levelDelta;
    }
  }

  console.log(
    JSON.stringify(
      {
        matches,
        baseSeed,
        balanced: {
          profile: 'balanced-v2',
          wins: balancedWins,
          winRate: balancedWins / matches,
          averageLevelGainOnWins: balancedWins > 0 ? balancedLevelGain / balancedWins : 0,
        },
        legacy: {
          profile: 'legacy-v1',
          wins: legacyWins,
          winRate: legacyWins / matches,
          averageLevelGainOnWins: legacyWins > 0 ? legacyLevelGain / legacyWins : 0,
        },
        summaries,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(message);
  process.exitCode = 1;
});

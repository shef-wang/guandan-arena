declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { createHeuristicAgent, GuandanArenaMatch } from './engine';
import { createSeededRandom } from '../game/cards';
import { createNewGame } from '../game/state';
import type { AiProfile } from '../game/ai';

interface MatchSummary {
  index: number;
  challengerTeam: 0 | 1;
  winnerTeam: 0 | 1;
  levelDelta: 1 | 2 | 3;
  placementKey: string;
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '20');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260413');
  const challengerProfile = parseProfile(process.env.CHALLENGER_PROFILE, 'legacy-v2.0');
  const opponentProfile = parseProfile(process.env.OPPONENT_PROFILE, 'legacy-v1');
  const summaries: MatchSummary[] = [];
  let challengerWins = 0;
  let opponentWins = 0;
  let challengerLevelGain = 0;
  let opponentLevelGain = 0;

  for (let index = 0; index < matches; index += 1) {
    const challengerTeam = (index % 2 === 0 ? 0 : 1) as 0 | 1;
    const random = createSeededRandom(baseSeed + index);
    const match = new GuandanArenaMatch({
      initialState: createNewGame(random),
      agents:
        challengerTeam === 0
          ? [
              createHeuristicAgent({ id: `challenger-${index}-0`, label: 'Challenger 0', profile: challengerProfile }),
              createHeuristicAgent({ id: `opponent-${index}-1`, label: 'Opponent 1', profile: opponentProfile }),
              createHeuristicAgent({ id: `challenger-${index}-2`, label: 'Challenger 2', profile: challengerProfile }),
              createHeuristicAgent({ id: `opponent-${index}-3`, label: 'Opponent 3', profile: opponentProfile }),
            ]
          : [
              createHeuristicAgent({ id: `opponent-${index}-0`, label: 'Opponent 0', profile: opponentProfile }),
              createHeuristicAgent({ id: `challenger-${index}-1`, label: 'Challenger 1', profile: challengerProfile }),
              createHeuristicAgent({ id: `opponent-${index}-2`, label: 'Opponent 2', profile: opponentProfile }),
              createHeuristicAgent({ id: `challenger-${index}-3`, label: 'Challenger 3', profile: challengerProfile }),
            ],
    });

    const state = await match.runUntilFinished({ maxTurns: 500 });
    if (!state.result) {
      throw new Error(`Match ${index + 1} finished without a result.`);
    }

    const winnerTeam = state.result.winnerTeam;
    summaries.push({
      index: index + 1,
      challengerTeam,
      winnerTeam,
      levelDelta: state.result.levelDelta,
      placementKey: state.result.placementKey,
    });

    if (winnerTeam === challengerTeam) {
      challengerWins += 1;
      challengerLevelGain += state.result.levelDelta;
    } else {
      opponentWins += 1;
      opponentLevelGain += state.result.levelDelta;
    }
  }

  console.log(
    JSON.stringify(
      {
        matches,
        baseSeed,
        challenger: {
          profile: challengerProfile,
          wins: challengerWins,
          winRate: challengerWins / matches,
          averageLevelGainOnWins: challengerWins > 0 ? challengerLevelGain / challengerWins : 0,
        },
        opponent: {
          profile: opponentProfile,
          wins: opponentWins,
          winRate: opponentWins / matches,
          averageLevelGainOnWins: opponentWins > 0 ? opponentLevelGain / opponentWins : 0,
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

function parseProfile(raw: string | undefined, fallback: AiProfile): AiProfile {
  if (raw === 'baseline' || raw === 'legacy-v1' || raw === 'legacy-vR' || raw === 'balanced-v2') {
    return raw;
  }

  if (raw && /^legacy-v2\.\d+$/.test(raw)) {
    return raw as AiProfile;
  }

  return fallback;
}

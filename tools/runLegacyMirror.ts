import { GuandanArenaMatch, createHeuristicAgent } from '../src/arena/engine';
import { createSeededRandom } from '../src/game/cards';
import { createNewGame } from '../src/game/state';

async function main(): Promise<void> {
  const seed = Number(process.argv[2] ?? '20260413');
  const match = new GuandanArenaMatch({
    initialState: createNewGame(createSeededRandom(seed)),
    agents: [
      createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 0' }),
      createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 1' }),
      createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 2' }),
      createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 3' }),
    ],
  });

  const state = await match.runUntilFinished({ maxTurns: 500 });
  console.log(
    JSON.stringify(
      {
        seed,
        result: state.result,
        finishOrder: state.finishOrder,
        turns: state.actionHistory.length,
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

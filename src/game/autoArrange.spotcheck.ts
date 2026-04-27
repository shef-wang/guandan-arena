declare const process: {
  stdout: { write(chunk: string): void };
  argv: string[];
};

import { createSeededRandom } from './cards';
import { createNewGame } from './state';
import { autoArrangeHand, findBestPartition } from './rules';
import type { Card } from './types';

// Standalone "specials-first" greedy reproduction for comparison.
function autoArrangeHandLegacyGreedy(_hand: Card[]): string[][] {
  // We cannot import the un-exported greedy directly; recreate it via the
  // zero-budget search which approximates "minimum plays" without specials
  // bonus. For a strict apples-to-apples with the OLD code, we run the new
  // findBestPartition with all special bonuses set to 0.
  return findBestPartition(_hand, {
    budget: { fourBomb: 0, fiveBomb: 0, straightFlush: 0 },
    timeLimitMs: 5_000,
  }).groups;
}

function totalPlays(hand: Card[], groups: string[][]): number {
  const claimed = new Set<string>(groups.flat());
  const singles = hand.filter((c) => !claimed.has(c.id)).length;
  return groups.length + singles;
}

const seeds = [1, 2, 3, 7, 17, 42, 123, 999, 2024, 31337];
const out = (line: string) => process.stdout.write(line + '\n');

out('seed | hand-size | smart-plays | min-plays | smart-elapsed-ms | timed-out');

let totalSmart = 0;
let totalMin = 0;
let smartBeatsOrEqualsMin = 0;

for (const seed of seeds) {
  const random = createSeededRandom(seed);
  const game = createNewGame(random);
  const hand = game.players[0].hand;

  const detail = findBestPartition(hand, { timeLimitMs: 5_000 });
  const smartPlays = totalPlays(hand, detail.groups);

  const minGroups = autoArrangeHandLegacyGreedy(hand);
  const minPlays = totalPlays(hand, minGroups);

  if (smartPlays <= minPlays + 3) {
    smartBeatsOrEqualsMin += 1;
  }

  totalSmart += smartPlays;
  totalMin += minPlays;

  out(
    `${seed.toString().padStart(5)} | ${hand.length.toString().padStart(9)} | ${smartPlays
      .toString()
      .padStart(11)} | ${minPlays.toString().padStart(9)} | ${detail.elapsedMs
      .toString()
      .padStart(15)} | ${detail.fallbackUsed ? 'YES' : 'no'}`,
  );

  // Also exercise the public wrapper to confirm parity.
  const wrapperGroups = autoArrangeHand(hand);
  const wrapperPlays = totalPlays(hand, wrapperGroups);
  if (wrapperPlays > smartPlays + 1) {
    out(`  WARN seed=${seed} wrapper=${wrapperPlays} differs from search=${smartPlays}`);
  }
}

out('');
out(`Avg smart plays: ${(totalSmart / seeds.length).toFixed(2)}`);
out(`Avg min plays:   ${(totalMin / seeds.length).toFixed(2)}`);
out(`Smart within min+budget on ${smartBeatsOrEqualsMin}/${seeds.length} seeds`);

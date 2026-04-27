declare const process: {
  exitCode?: number;
  stdout: { write(chunk: string): void };
};

import { createDeck, createSeededRandom, shuffle } from './cards';
import { autoArrangeHand, findBestPartition, AUTO_ARRANGE_BUDGET } from './rules';
import type { Card } from './types';

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, detail });
}

function findCard(deck: Card[], match: Partial<Card>): Card {
  const card = deck.find((candidate) => {
    return Object.entries(match).every(([key, value]) => (candidate as unknown as Record<string, unknown>)[key] === value);
  });
  if (!card) {
    throw new Error(`Card not found for match ${JSON.stringify(match)}`);
  }
  return card;
}

function takeCardsByIds(deck: Card[], ids: string[]): Card[] {
  const out: Card[] = [];
  for (const id of ids) {
    const card = deck.find((candidate) => candidate.id === id);
    if (!card) {
      throw new Error(`Card with id ${id} not in deck`);
    }
    out.push(card);
  }
  return out;
}

function describePartition(cards: Card[], groups: string[][]): string {
  const lookup = new Map(cards.map((card) => [card.id, card] as const));
  const claimed = new Set(groups.flat());
  const groupDescriptions = groups.map((group) =>
    group
      .map((id) => {
        const card = lookup.get(id);
        if (!card) {
          return id;
        }
        const wild = card.isWild ? '*' : '';
        return `${card.rank}${wild}${card.suit[0]}`;
      })
      .join('+'),
  );
  const singletons = cards
    .filter((card) => !claimed.has(card.id))
    .map((card) => `${card.rank}${card.suit[0]}`);
  return `[${groupDescriptions.join(', ')}]${singletons.length ? ` singles: ${singletons.join(',')}` : ''}`;
}

function totalPlays(cards: Card[], groups: string[][]): number {
  const claimed = new Set(groups.flat());
  const singletons = cards.filter((card) => !claimed.has(card.id)).length;
  return groups.length + singletons;
}

function expect(condition: boolean, name: string, detail?: string): void {
  record(name, condition, condition ? undefined : detail);
}

// -----------------------------------------------------------------------------
// Test: empty / trivial hands
// -----------------------------------------------------------------------------
{
  expect(autoArrangeHand([]).length === 0, 'empty hand returns []');
  const deck = createDeck();
  const oneCard = [findCard(deck, { id: '1-clubs-3' })];
  expect(autoArrangeHand(oneCard).length === 0, '1-card hand returns []');
}

// -----------------------------------------------------------------------------
// Test: a single 4-bomb of fives that has no good alternative -> keep the bomb.
// -----------------------------------------------------------------------------
{
  const deck = createDeck();
  const hand = [
    findCard(deck, { id: '1-clubs-5' }),
    findCard(deck, { id: '1-diamonds-5' }),
    findCard(deck, { id: '2-clubs-5' }),
    findCard(deck, { id: '2-diamonds-5' }),
  ];
  const result = findBestPartition(hand);
  const bombGroup = result.groups.find((group) => group.length === 4);
  expect(
    bombGroup !== undefined,
    'isolated 4-bomb of 5s is kept when no alternative exists',
    describePartition(hand, result.groups),
  );
}

// -----------------------------------------------------------------------------
// Test: 4 fives + a 2-3-4-?-6 set that can become a 5-straight if we sacrifice
// one of the fives. Greedy keeps the bomb (-> 5 plays), smart takes the
// straight + triple (-> 2 plays). Smart should win.
// -----------------------------------------------------------------------------
{
  const deck = createDeck();
  const hand = [
    findCard(deck, { id: '1-clubs-5' }),
    findCard(deck, { id: '1-diamonds-5' }),
    findCard(deck, { id: '2-clubs-5' }),
    findCard(deck, { id: '2-diamonds-5' }),
    findCard(deck, { id: '1-clubs-2' }),
    findCard(deck, { id: '1-clubs-3' }),
    findCard(deck, { id: '1-clubs-4' }),
    findCard(deck, { id: '1-clubs-6' }),
  ];
  const result = findBestPartition(hand);
  const greedyPlayCount = totalPlays(hand, result.groups);
  process.stdout.write(`fives+straight partition: ${describePartition(hand, result.groups)}\n`);
  process.stdout.write(`  plays: ${result.plays.map((p) => p.type).join(',')}\n`);
  expect(
    greedyPlayCount <= 2,
    'fives+straight: smart partition uses <= 2 plays',
    `got ${greedyPlayCount}: ${describePartition(hand, result.groups)}`,
  );
  // The 5 cards 2c,3c,4c,5c,6c happen to be all clubs, so SF is even better
  // than a plain straight. Accept either.
  const hasSequenceWith5 = result.plays.some(
    (play) =>
      (play.type === 'straight' || play.type === 'straight-flush') &&
      play.cards.some((card) => card.rank === '5'),
  );
  expect(hasSequenceWith5, 'fives+straight: a straight (or SF) using a 5 is included');
  const has4Bomb = result.plays.some((play) => play.type === 'bomb' && play.bombSize === 4);
  expect(!has4Bomb, 'fives+straight: 4-bomb is dropped in favour of sequence+triple');
}

// -----------------------------------------------------------------------------
// Test: two disjoint 4-bombs (5s and 6s) — both should be kept.
// -----------------------------------------------------------------------------
{
  const deck = createDeck();
  const hand = [
    findCard(deck, { id: '1-clubs-5' }),
    findCard(deck, { id: '1-diamonds-5' }),
    findCard(deck, { id: '2-clubs-5' }),
    findCard(deck, { id: '2-diamonds-5' }),
    findCard(deck, { id: '1-clubs-6' }),
    findCard(deck, { id: '1-diamonds-6' }),
    findCard(deck, { id: '2-clubs-6' }),
    findCard(deck, { id: '2-diamonds-6' }),
  ];
  const result = findBestPartition(hand);
  const bombs = result.plays.filter((play) => play.type === 'bomb' && play.bombSize === 4);
  expect(
    bombs.length === 2,
    'two disjoint 4-bombs both kept',
    `got ${bombs.length}: ${describePartition(hand, result.groups)}`,
  );
}

// -----------------------------------------------------------------------------
// Test: joker bomb is always taken even when many alternatives exist.
// -----------------------------------------------------------------------------
{
  const deck = createDeck();
  const hand = [
    findCard(deck, { id: '1-joker-SJ' }),
    findCard(deck, { id: '2-joker-SJ' }),
    findCard(deck, { id: '1-joker-BJ' }),
    findCard(deck, { id: '2-joker-BJ' }),
    findCard(deck, { id: '1-clubs-3' }),
    findCard(deck, { id: '1-diamonds-3' }),
  ];
  const result = findBestPartition(hand);
  const hasJokerBomb = result.plays.some((play) => play.type === 'joker-bomb');
  expect(hasJokerBomb, 'joker-bomb always taken', describePartition(hand, result.groups));
}

// -----------------------------------------------------------------------------
// Test: regression mirroring the screenshot. Hand contains:
//  - hearts 8,9,10,Q + the wild (forming SF using wild as J)
//  - spades 6,7,8,9,10 (clean SF)
//  - four fives (4-bomb candidate)
//  - 2 threes (pair)
//  - 5 contiguous singles 10♦,J♦,Q♦,K♣,A♣ (form a 10-J-Q-K-A straight)
//  - misc singles: A♣ already, plus 8♦, 6♣, 4♦, 2♣
// Expectation: the partition uses the 10-J-Q-K-A straight and the triple of
// fives instead of the 4-bomb, matching the user's "good" arrangement.
// -----------------------------------------------------------------------------
{
  const deck = createDeck();
  const ids = [
    '1-hearts-8',
    '1-hearts-9',
    '1-hearts-10',
    '1-hearts-Q',
    '1-hearts-A',
    '1-spades-6',
    '1-spades-7',
    '1-spades-8',
    '1-spades-9',
    '1-spades-10',
    '1-diamonds-5',
    '2-diamonds-5',
    '1-clubs-5',
    '1-hearts-5',
    '1-diamonds-3',
    '1-clubs-3',
    '1-diamonds-10',
    '1-diamonds-J',
    '1-diamonds-Q',
    '1-clubs-K',
    '1-clubs-A',
    '1-diamonds-8',
    '1-clubs-6',
    '1-diamonds-4',
    '1-clubs-2',
  ];
  const hand = takeCardsByIds(deck, ids);
  const result = findBestPartition(hand, { timeLimitMs: 30_000, nodeLimit: 5_000_000 });
  const playCount = totalPlays(hand, result.groups);

  const hasMixedHighStraight = result.plays.some((play) => {
    if (play.type !== 'straight') {
      return false;
    }
    const ranks = new Set(play.cards.map((card) => card.rank));
    return ranks.has('10') && ranks.has('J') && ranks.has('Q') && ranks.has('K') && ranks.has('A');
  });
  const sfCount = result.plays.filter((play) => play.type === 'straight-flush').length;

  expect(hasMixedHighStraight, 'screenshot regression: 10-J-Q-K-A straight is formed');
  expect(sfCount === 2, `screenshot regression: both SFs preserved (got ${sfCount})`);
  expect(
    playCount <= 9,
    `screenshot regression: total plays <= 9 (got ${playCount})`,
    describePartition(hand, result.groups),
  );
  expect(!result.fallbackUsed, `screenshot regression: search did not time out (elapsed=${result.elapsedMs}ms)`);

  process.stdout.write(`screenshot partition: ${describePartition(hand, result.groups)}\n`);
  process.stdout.write(`screenshot stats: plays=${playCount} cost=${result.cost.score} elapsed=${result.elapsedMs}ms nodes=${result.nodeCount}\n`);
}

// -----------------------------------------------------------------------------
// Performance / sanity: random 27-card hands. Smart partition's play-count
// should be no worse than the greedy's by more than the special budget.
// -----------------------------------------------------------------------------
{
  const greedyBudgetSlack = AUTO_ARRANGE_BUDGET.fourBomb + AUTO_ARRANGE_BUDGET.straightFlush;
  let regressed = 0;
  let smartTotal = 0;
  let greedyEqOrBetter = 0;
  let timeouts = 0;

  let totalElapsed = 0;
  let maxElapsed = 0;

  for (let seed = 1; seed <= 10; seed += 1) {
    const random = createSeededRandom(seed);
    const deck = shuffle(createDeck(), random);
    const hand = deck.slice(0, 27);
    const smart = findBestPartition(hand);
    const smartPlays = totalPlays(hand, smart.groups);

    if (smart.fallbackUsed) {
      timeouts += 1;
    }

    smartTotal += smartPlays;
    totalElapsed += smart.elapsedMs;
    if (smart.elapsedMs > maxElapsed) {
      maxElapsed = smart.elapsedMs;
    }

    // Compare against the legacy greedy (cost weights all = 1) to ensure the
    // smart search never produces a worse partition.
    const greedy = findBestPartition(hand, {
      timeLimitMs: 5_000,
      budget: { fourBomb: 0, fiveBomb: 0, straightFlush: 0 },
    });
    const greedyPlays = totalPlays(hand, greedy.groups);

    if (greedyPlays <= smartPlays) {
      greedyEqOrBetter += 1;
    }

    if (smartPlays > greedyPlays + greedyBudgetSlack) {
      regressed += 1;
      process.stdout.write(`  seed=${seed} smart=${smartPlays} greedy=${greedyPlays}\n`);
    }
  }

  expect(regressed === 0, 'random hands: smart never exceeds greedy + budget slack');
  process.stdout.write(
    `random sanity: avg smart plays=${(smartTotal / 10).toFixed(1)} greedy<=smart in ${greedyEqOrBetter}/10 trials timeouts=${timeouts} avgMs=${(totalElapsed / 10).toFixed(0)} maxMs=${maxElapsed}\n`,
  );
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------
const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

process.stdout.write(`\n=== AUTO ARRANGE VERIFICATION ===\n`);
for (const r of results) {
  const status = r.passed ? 'PASS' : 'FAIL';
  const detail = r.detail ? ` :: ${r.detail}` : '';
  process.stdout.write(`[${status}] ${r.name}${detail}\n`);
}
process.stdout.write(`\nResult: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exitCode = 1;
}

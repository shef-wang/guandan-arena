import { getRankText, isJokerRank, isNormalRank } from './cards';
import {
  ALL_RANKS,
  NORMAL_RANKS,
  RANK_POWER,
  type Card,
  type Play,
  type Rank,
  type Seat,
  type Suit,
} from './types';

const STRAIGHT_WINDOWS = buildWindows(5);
const PAIR_RUN_WINDOWS = buildWindows(3);
const TRIPLE_RUN_WINDOWS = buildWindows(2);
const SPECIAL_TYPE_ORDER = 1_000_000;

interface Requirement {
  rank: Rank;
  count: number;
  suit?: Suit;
}

export function sameTeam(left: Seat, right: Seat): boolean {
  return left % 2 === right % 2;
}

export function isSpecialPlay(play: Play): boolean {
  return play.type === 'bomb' || play.type === 'straight-flush' || play.type === 'joker-bomb';
}

export function enumerateExactPlays(cards: Card[]): Play[] {
  if (cards.length === 0) {
    return [];
  }

  const plays = new Map<string, Play>();

  if (cards.length === 1) {
    addPlay(
      plays,
      createPlay('single', cards, RANK_POWER[getSingleRank(cards[0])], {
        primaryRank: getSingleRank(cards[0]),
      }),
    );
  }

  addSameRankPlayOptions(plays, cards);
  addFullHouseOptions(plays, cards);
  addSequenceOptions(plays, cards, STRAIGHT_WINDOWS, 1, 'straight');
  addSequenceOptions(plays, cards, PAIR_RUN_WINDOWS, 2, 'pair-run');
  addSequenceOptions(plays, cards, TRIPLE_RUN_WINDOWS, 3, 'triple-run');
  addStraightFlushOptions(plays, cards);
  addFourJokerBombOption(plays, cards);

  return [...plays.values()];
}

export function generateAllPlays(hand: Card[]): Play[] {
  const plays = new Map<string, Play>();
  const rankGroups = groupCardsByRank(hand.filter((card) => !card.isWild));
  const wildCards = hand.filter((card) => card.isWild);

  for (const rank of ALL_RANKS) {
    const actualCount = rankGroups.get(rank)?.length ?? 0;
    if (actualCount === 0 && rank !== 'A') {
      continue;
    }

    const single = pickCardsForRequirements(hand, [{ rank, count: 1 }]);
    if (!single) {
      continue;
    }

    addPlay(
      plays,
      createPlay('single', single, RANK_POWER[rank], {
        primaryRank: rank,
      }),
    );
  }

  for (const rank of ALL_RANKS) {
    const actualCount = rankGroups.get(rank)?.length ?? 0;

    if (isJokerRank(rank)) {
      if (actualCount >= 2) {
        const pair = pickCardsForRequirements(hand, [{ rank, count: 2 }]);
        if (pair) {
          addPlay(
            plays,
            createPlay('pair', pair, RANK_POWER[rank], {
              primaryRank: rank,
            }),
          );
        }
      }

      continue;
    }

    const totalCount = actualCount + wildCards.length;
    if (totalCount >= 2 && (actualCount > 0 || rank === 'A')) {
      const pair = pickCardsForRequirements(hand, [{ rank, count: 2 }]);
      if (pair) {
        addPlay(
          plays,
          createPlay('pair', pair, RANK_POWER[rank], {
            primaryRank: rank,
          }),
        );
      }
    }

    if (totalCount >= 3 && actualCount > 0) {
      const triple = pickCardsForRequirements(hand, [{ rank, count: 3 }]);
      if (triple) {
        addPlay(
          plays,
          createPlay('triple', triple, RANK_POWER[rank], {
            primaryRank: rank,
          }),
        );
      }
    }

    for (let bombSize = 4; bombSize <= Math.min(totalCount, 8); bombSize += 1) {
      if (actualCount === 0) {
        continue;
      }

      const bomb = pickCardsForRequirements(hand, [{ rank, count: bombSize }]);
      if (bomb) {
        addPlay(
          plays,
          createPlay('bomb', bomb, RANK_POWER[rank], {
            bombSize,
            primaryRank: rank,
          }),
        );
      }
    }
  }

  for (const tripleRank of NORMAL_RANKS) {
    for (const pairRank of ALL_RANKS) {
      if (pairRank === tripleRank) {
        continue;
      }

      if (isJokerRank(pairRank) && (rankGroups.get(pairRank)?.length ?? 0) < 2) {
        continue;
      }

      const fullHouse = pickCardsForRequirements(hand, [
        { rank: tripleRank, count: 3 },
        { rank: pairRank, count: 2 },
      ]);

      if (!fullHouse) {
        continue;
      }

      addPlay(
        plays,
        createPlay('full-house', fullHouse, RANK_POWER[tripleRank], {
          primaryRank: tripleRank,
        }),
      );
    }
  }

  addGeneratedSequences(plays, hand, STRAIGHT_WINDOWS, 1, 'straight');
  addGeneratedSequences(plays, hand, PAIR_RUN_WINDOWS, 2, 'pair-run');
  addGeneratedSequences(plays, hand, TRIPLE_RUN_WINDOWS, 3, 'triple-run');
  addGeneratedStraightFlushes(plays, hand);

  if ((rankGroups.get('SJ')?.length ?? 0) === 2 && (rankGroups.get('BJ')?.length ?? 0) === 2) {
    const jokerBomb = pickCardsForRequirements(hand, [
      { rank: 'SJ', count: 2 },
      { rank: 'BJ', count: 2 },
    ]);

    if (jokerBomb) {
      addPlay(plays, createPlay('joker-bomb', jokerBomb, SPECIAL_TYPE_ORDER, {}));
    }
  }

  return [...plays.values()].sort(comparePlayPreference);
}

export function filterLegalPlays(plays: Play[], target: Play | null): Play[] {
  if (!target) {
    return [...plays];
  }

  return plays.filter((play) => beats(play, target));
}

export function sortPlayOptionsForContext(plays: Play[], target: Play | null): Play[] {
  return [...plays].sort((left, right) => {
    const leftScore = getPlaySelectionWeight(left, target);
    const rightScore = getPlaySelectionWeight(right, target);

    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }

    return comparePlayPreference(left, right);
  });
}

export function beats(challenger: Play, target: Play): boolean {
  if (challenger.type === target.type) {
    if (challenger.type === 'joker-bomb') {
      return false;
    }

    if (challenger.type === 'bomb') {
      if (challenger.bombSize !== target.bombSize) {
        return (challenger.bombSize ?? 0) > (target.bombSize ?? 0);
      }

      return challenger.primaryValue > target.primaryValue;
    }

    return challenger.primaryValue > target.primaryValue;
  }

  if (!isSpecialPlay(challenger) && !isSpecialPlay(target)) {
    return false;
  }

  if (challenger.type === 'joker-bomb') {
    return target.type !== 'joker-bomb';
  }

  if (target.type === 'joker-bomb') {
    return false;
  }

  if (challenger.type === 'straight-flush') {
    if (target.type === 'straight-flush') {
      return challenger.primaryValue > target.primaryValue;
    }

    if (target.type === 'bomb') {
      return (target.bombSize ?? 0) <= 5;
    }

    return true;
  }

  if (challenger.type === 'bomb') {
    if (!isSpecialPlay(target)) {
      return true;
    }

    if (target.type === 'straight-flush') {
      return (challenger.bombSize ?? 0) >= 6;
    }
  }

  return false;
}

export function getPlayDisplayRank(play: Play): string {
  if (play.type === 'joker-bomb') {
    return '四王炸';
  }

  if (play.type === 'straight' || play.type === 'pair-run' || play.type === 'triple-run' || play.type === 'straight-flush') {
    return play.sequence ? describeSequence(play.sequence) : play.label;
  }

  return play.label;
}

function addSameRankPlayOptions(plays: Map<string, Play>, cards: Card[]): void {
  const rank = resolveSameRank(cards);

  if (!rank) {
    return;
  }

  if (cards.length === 2) {
    addPlay(
      plays,
      createPlay('pair', cards, RANK_POWER[rank], {
        primaryRank: rank,
      }),
    );
    return;
  }

  if (cards.length === 3 && !isJokerRank(rank)) {
    addPlay(
      plays,
      createPlay('triple', cards, RANK_POWER[rank], {
        primaryRank: rank,
      }),
    );
    return;
  }

  if (cards.length >= 4 && cards.length <= 8 && !isJokerRank(rank)) {
    addPlay(
      plays,
      createPlay('bomb', cards, RANK_POWER[rank], {
        bombSize: cards.length,
        primaryRank: rank,
      }),
    );
  }
}

function addFullHouseOptions(plays: Map<string, Play>, cards: Card[]): void {
  if (cards.length !== 5) {
    return;
  }

  const counts = countNonWildRanks(cards);
  const wildCount = getWildCount(cards);

  for (const tripleRank of NORMAL_RANKS) {
    const tripleCount = counts.get(tripleRank) ?? 0;
    if (tripleCount > 3) {
      continue;
    }

    const neededForTriple = Math.max(0, 3 - tripleCount);
    if (neededForTriple > wildCount) {
      continue;
    }

    const remainingWild = wildCount - neededForTriple;

    for (const pairRank of ALL_RANKS) {
      if (pairRank === tripleRank) {
        continue;
      }

      if (!canFillPair(counts, pairRank, remainingWild)) {
        continue;
      }

      if (!allRanksCoveredByFullHouse(counts, tripleRank, pairRank)) {
        continue;
      }

      addPlay(
        plays,
        createPlay('full-house', cards, RANK_POWER[tripleRank], {
          primaryRank: tripleRank,
        }),
      );
    }
  }
}

function addSequenceOptions(
  plays: Map<string, Play>,
  cards: Card[],
  windows: number[][],
  multiplicity: number,
  type: Play['type'],
): void {
  for (const window of windows) {
    if (!matchesWindow(cards, window, multiplicity)) {
      continue;
    }

    addPlay(
      plays,
      createPlay(type, cards, window[window.length - 1], {
        sequence: window,
      }),
    );
  }
}

function addStraightFlushOptions(plays: Map<string, Play>, cards: Card[]): void {
  if (cards.length !== 5) {
    return;
  }

  for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as const) {
    for (const window of STRAIGHT_WINDOWS) {
      if (!matchesWindow(cards, window, 1, suit)) {
        continue;
      }

      addPlay(
        plays,
        createPlay('straight-flush', cards, window[window.length - 1], {
          sequence: window,
          suit,
        }),
      );
    }
  }
}

function addFourJokerBombOption(plays: Map<string, Play>, cards: Card[]): void {
  if (cards.length !== 4 || getWildCount(cards) > 0) {
    return;
  }

  const counts = countNonWildRanks(cards);
  if ((counts.get('SJ') ?? 0) === 2 && (counts.get('BJ') ?? 0) === 2) {
    addPlay(plays, createPlay('joker-bomb', cards, SPECIAL_TYPE_ORDER, {}));
  }
}

function addGeneratedSequences(
  plays: Map<string, Play>,
  hand: Card[],
  windows: number[][],
  multiplicity: number,
  type: Play['type'],
): void {
  for (const window of windows) {
    const requirements = window.map((value) => ({
      rank: valueToRank(value),
      count: multiplicity,
    }));
    const cards = pickCardsForRequirements(hand, requirements);

    if (!cards) {
      continue;
    }

    addPlay(
      plays,
      createPlay(type, cards, window[window.length - 1], {
        sequence: window,
      }),
    );
  }
}

function addGeneratedStraightFlushes(plays: Map<string, Play>, hand: Card[]): void {
  for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as const) {
    for (const window of STRAIGHT_WINDOWS) {
      const requirements = window.map((value) => ({
        rank: valueToRank(value),
        count: 1,
        suit,
      }));
      const cards = pickCardsForRequirements(hand, requirements);

      if (!cards) {
        continue;
      }

      addPlay(
        plays,
        createPlay('straight-flush', cards, window[window.length - 1], {
          sequence: window,
          suit,
        }),
      );
    }
  }
}

function matchesWindow(cards: Card[], window: number[], multiplicity: number, suit?: Suit): boolean {
  const expectedSize = window.length * multiplicity;
  if (cards.length !== expectedSize) {
    return false;
  }

  const nonWildCards = cards.filter((card) => !card.isWild);
  if (nonWildCards.some((card) => isJokerRank(card.rank))) {
    return false;
  }

  if (suit && nonWildCards.some((card) => card.suit !== suit)) {
    return false;
  }

  const allowedRanks = new Set(window.map(valueToRank));
  const counts = new Map<Rank, number>();

  for (const card of nonWildCards) {
    if (!allowedRanks.has(card.rank)) {
      return false;
    }

    const nextCount = (counts.get(card.rank) ?? 0) + 1;
    if (nextCount > multiplicity) {
      return false;
    }

    counts.set(card.rank, nextCount);
  }

  const missing = window.reduce((total, value) => {
    const rank = valueToRank(value);
    return total + (multiplicity - (counts.get(rank) ?? 0));
  }, 0);

  return missing === getWildCount(cards);
}

function resolveSameRank(cards: Card[]): Rank | null {
  const nonWildRanks = [...new Set(cards.filter((card) => !card.isWild).map((card) => card.rank))];

  if (nonWildRanks.length === 0) {
    return 'A';
  }

  if (nonWildRanks.length > 1) {
    return null;
  }

  const [rank] = nonWildRanks;
  if (!rank) {
    return null;
  }

  if (isJokerRank(rank) && getWildCount(cards) > 0) {
    return null;
  }

  return rank;
}

function canFillPair(counts: Map<Rank, number>, pairRank: Rank, remainingWild: number): boolean {
  const pairCount = counts.get(pairRank) ?? 0;
  if (pairCount > 2) {
    return false;
  }

  if (isJokerRank(pairRank)) {
    return pairCount === 2;
  }

  return Math.max(0, 2 - pairCount) <= remainingWild;
}

function allRanksCoveredByFullHouse(counts: Map<Rank, number>, tripleRank: Rank, pairRank: Rank): boolean {
  return [...counts.keys()].every((rank) => rank === tripleRank || rank === pairRank);
}

function pickCardsForRequirements(hand: Card[], requirements: Requirement[]): Card[] | null {
  const selected: Card[] = [];
  const usedIds = new Set<string>();
  const wildCards = hand.filter((card) => card.isWild);

  for (const requirement of requirements) {
    const actualMatches = hand
      .filter(
        (card) =>
          !card.isWild &&
          !usedIds.has(card.id) &&
          card.rank === requirement.rank &&
          (!requirement.suit || card.suit === requirement.suit),
      )
      .slice(0, requirement.count);

    for (const card of actualMatches) {
      selected.push(card);
      usedIds.add(card.id);
    }

    const missing = requirement.count - actualMatches.length;
    if (missing === 0) {
      continue;
    }

    if (isJokerRank(requirement.rank)) {
      return null;
    }

    const wildMatches = wildCards.filter((card) => !usedIds.has(card.id)).slice(0, missing);
    if (wildMatches.length !== missing) {
      return null;
    }

    for (const card of wildMatches) {
      selected.push(card);
      usedIds.add(card.id);
    }
  }

  return selected.length === requirements.reduce((total, item) => total + item.count, 0) ? selected : null;
}

function addPlay(plays: Map<string, Play>, play: Play): void {
  const existing = plays.get(play.key);
  if (!existing || compareConcreteCost(play, existing) < 0) {
    plays.set(play.key, play);
  }
}

function createPlay(
  type: Play['type'],
  cards: Card[],
  primaryValue: number,
  options: {
    bombSize?: number;
    primaryRank?: Rank;
    sequence?: number[];
    suit?: Suit;
  },
): Play {
  const wildCount = getWildCount(cards);
  return {
    key: buildPlayKey(type, primaryValue, options.bombSize, options.suit),
    type,
    cards: sortPlayCardsForDisplay(type, cards, options.sequence),
    size: cards.length,
    primaryValue,
    label: buildPlayLabel(type, primaryValue, options.bombSize, options.primaryRank, options.sequence),
    usesWild: wildCount > 0,
    wildCount,
    bombSize: options.bombSize,
    suit: options.suit,
    sequence: options.sequence,
  };
}

function sortPlayCardsForDisplay(type: Play['type'], cards: Card[], sequence?: number[]): Card[] {
  const decorated = cards.map((card, index) => ({ card, index }));

  if (type === 'straight' || type === 'pair-run' || type === 'triple-run' || type === 'straight-flush') {
    const sequenceOrder = new Map<Rank, number>(
      (sequence ?? []).map((value, index) => [valueToRank(value), index] as const),
    );

    return decorated
      .sort((left, right) => {
        const leftOrder = sequenceOrder.get(left.card.isWild ? 'A' : left.card.rank) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = sequenceOrder.get(right.card.isWild ? 'A' : right.card.rank) ?? Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        return left.index - right.index;
      })
      .map(({ card }) => card);
  }

  return [...cards];
}

function buildPlayKey(type: Play['type'], primaryValue: number, bombSize?: number, suit?: Suit): string {
  return [type, primaryValue, bombSize ?? 0, suit ?? 'none'].join(':');
}

function buildPlayLabel(
  type: Play['type'],
  primaryValue: number,
  bombSize?: number,
  primaryRank?: Rank,
  sequence?: number[],
): string {
  if (type === 'joker-bomb') {
    return '四王炸';
  }

  if (type === 'straight') {
    return `顺子 ${describeSequence(sequence)}`;
  }

  if (type === 'pair-run') {
    return `连对 ${describeSequence(sequence)}`;
  }

  if (type === 'triple-run') {
    return `钢板 ${describeSequence(sequence)}`;
  }

  if (type === 'straight-flush') {
    return `同花顺 ${describeSequence(sequence)}`;
  }

  if (type === 'bomb') {
    return `${bombSize} 张炸 ${getRankText(primaryRank ?? valueToRank(primaryValue))}`;
  }

  const rankText = getRankText(primaryRank ?? valueToRank(primaryValue));
  const nameMap: Record<Exclude<Play['type'], 'bomb' | 'straight' | 'pair-run' | 'triple-run' | 'straight-flush' | 'joker-bomb'>, string> = {
    single: '单张',
    pair: '对子',
    triple: '三张',
    'full-house': '三带二',
  };

  return `${nameMap[type]} ${rankText}`;
}

function describeSequence(sequence?: number[]): string {
  if (!sequence || sequence.length === 0) {
    return '';
  }

  return sequence.map((value) => getRankText(valueToRank(value))).join('-');
}

function buildWindows(length: number): number[][] {
  const windows: number[][] = [];
  for (let start = 1; start <= 15 - length; start += 1) {
    windows.push(Array.from({ length }, (_, offset) => start + offset));
  }
  return windows;
}

function valueToRank(value: number): Rank {
  if (value === 1 || value === 14) {
    return 'A';
  }

  if (value >= 2 && value <= 10) {
    return String(value) as Rank;
  }

  if (value === 11) {
    return 'J';
  }

  if (value === 12) {
    return 'Q';
  }

  if (value === 13) {
    return 'K';
  }

  return 'A';
}

function getSingleRank(card: Card): Rank {
  if (card.rank === 'SJ' || card.rank === 'BJ') {
    return card.rank;
  }

  return card.isWild ? 'A' : card.rank;
}

function getPlaySelectionWeight(play: Play, target: Play | null): number {
  const specialWeight = getSpecialWeight(play);
  if (!target) {
    return specialWeight * 1_000 + play.primaryValue * 10 + play.wildCount;
  }

  return specialWeight * 1_000 + play.primaryValue * 10 + play.wildCount;
}

function getSpecialWeight(play: Play): number {
  if (!isSpecialPlay(play)) {
    const typeWeight: Record<'single' | 'pair' | 'triple' | 'full-house' | 'straight' | 'pair-run' | 'triple-run', number> = {
      single: 1,
      pair: 2,
      triple: 3,
      'full-house': 4,
      straight: 5,
      'pair-run': 6,
      'triple-run': 7,
    };

    return typeWeight[play.type as keyof typeof typeWeight];
  }

  if (play.type === 'joker-bomb') {
    return 99;
  }

  if (play.type === 'straight-flush') {
    return 53;
  }

  return 40 + (play.bombSize ?? 0);
}

function compareConcreteCost(left: Play, right: Play): number {
  if (left.wildCount !== right.wildCount) {
    return left.wildCount - right.wildCount;
  }

  const leftPower = left.cards.reduce((total, card) => total + RANK_POWER[card.rank], 0);
  const rightPower = right.cards.reduce((total, card) => total + RANK_POWER[card.rank], 0);
  if (leftPower !== rightPower) {
    return leftPower - rightPower;
  }

  return left.cards.map((card) => card.id).join('|').localeCompare(right.cards.map((card) => card.id).join('|'));
}

function comparePlayPreference(left: Play, right: Play): number {
  const specialGap = getSpecialWeight(left) - getSpecialWeight(right);
  if (specialGap !== 0) {
    return specialGap;
  }

  if (left.primaryValue !== right.primaryValue) {
    return left.primaryValue - right.primaryValue;
  }

  if ((left.bombSize ?? 0) !== (right.bombSize ?? 0)) {
    return (left.bombSize ?? 0) - (right.bombSize ?? 0);
  }

  return compareConcreteCost(left, right);
}

function countNonWildRanks(cards: Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();

  for (const card of cards) {
    if (card.isWild) {
      continue;
    }

    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }

  return counts;
}

function groupCardsByRank(cards: Card[]): Map<Rank, Card[]> {
  const groups = new Map<Rank, Card[]>();

  for (const card of cards) {
    const group = groups.get(card.rank) ?? [];
    group.push(card);
    groups.set(card.rank, group);
  }

  return groups;
}

function getWildCount(cards: Card[]): number {
  return cards.filter((card) => card.isWild).length;
}

export interface AutoArrangeBudget {
  fourBomb: number;
  fiveBomb: number;
  straightFlush: number;
}

// Marginal hand-cost we're willing to pay to keep a special play.
// Example: fourBomb=2 means "accept a 4-bomb only if it makes the partition at most 2 hands longer".
// Joker-bomb and 6+ bombs are always taken (treated as effectively infinite credit).
export const AUTO_ARRANGE_BUDGET: AutoArrangeBudget = {
  fourBomb: 2,
  fiveBomb: 2,
  straightFlush: 3,
};

const ALWAYS_TAKE_BONUS = 1_000;
const DEFAULT_TIME_LIMIT_MS = 1_500;
const DEFAULT_NODE_LIMIT = 1_000_000;
const MAX_BITMASK_CARDS = 30;

interface PartitionCost {
  score: number;
  wilds: number;
  primarySum: number;
}

export interface PartitionResult {
  groups: string[][];
  plays: Play[];
  cost: PartitionCost;
  fallbackUsed: boolean;
  nodeCount: number;
  elapsedMs: number;
}

interface FindBestPartitionOptions {
  budget?: AutoArrangeBudget;
  timeLimitMs?: number;
  nodeLimit?: number;
}

function playCostScore(play: Play, budget: AutoArrangeBudget): number {
  if (play.type === 'joker-bomb') {
    return 1 - ALWAYS_TAKE_BONUS;
  }
  if (play.type === 'bomb') {
    const size = play.bombSize ?? 4;
    if (size >= 6) {
      return 1 - ALWAYS_TAKE_BONUS;
    }
    if (size === 5) {
      return 1 - budget.fiveBomb;
    }
    return 1 - budget.fourBomb;
  }
  if (play.type === 'straight-flush') {
    return 1 - budget.straightFlush;
  }
  return 1;
}

function playToCost(play: Play, budget: AutoArrangeBudget): PartitionCost {
  return {
    score: playCostScore(play, budget),
    wilds: play.wildCount,
    primarySum: play.primaryValue,
  };
}

function zeroCost(): PartitionCost {
  return { score: 0, wilds: 0, primarySum: 0 };
}

function addCost(left: PartitionCost, right: PartitionCost): PartitionCost {
  return {
    score: left.score + right.score,
    wilds: left.wilds + right.wilds,
    primarySum: left.primarySum + right.primarySum,
  };
}

function compareCost(left: PartitionCost, right: PartitionCost): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }
  if (left.wilds !== right.wilds) {
    return left.wilds - right.wilds;
  }
  // Prefer partitions that retain higher-value cards in fewer plays.
  return right.primarySum - left.primarySum;
}

interface SearchEntry {
  cost: PartitionCost;
  plays: Play[];
}

interface IndexedPlay {
  play: Play;
  mask: number;
  costScore: number;
  costWilds: number;
  costPrimary: number;
}

function combinations<T>(items: T[], pick: number, callback: (subset: T[]) => void): void {
  if (pick === 0) {
    callback([]);
    return;
  }
  if (pick > items.length) {
    return;
  }
  const indices = Array.from({ length: pick }, (_, i) => i);
  while (true) {
    callback(indices.map((i) => items[i]));
    let cursor = pick - 1;
    while (cursor >= 0 && indices[cursor] === items.length - pick + cursor) {
      cursor -= 1;
    }
    if (cursor < 0) {
      break;
    }
    indices[cursor] += 1;
    for (let j = cursor + 1; j < pick; j += 1) {
      indices[j] = indices[j - 1] + 1;
    }
  }
}

function enumerateRankCombos(
  actuals: Card[],
  wilds: Card[],
  count: number,
  callback: (cards: Card[], wildCount: number) => void,
): void {
  const maxWilds = Math.min(count, wilds.length);
  for (let w = 0; w <= maxWilds; w += 1) {
    const a = count - w;
    if (a < 0 || a > actuals.length) {
      continue;
    }
    combinations(actuals, a, (actualSubset) => {
      combinations(wilds, w, (wildSubset) => {
        callback([...actualSubset, ...wildSubset], w);
      });
    });
  }
}

function enumerateRankCombosWithWildIds(
  actuals: Card[],
  wilds: Card[],
  count: number,
  callback: (cards: Card[], wildIds: Set<string>) => void,
): void {
  const maxWilds = Math.min(count, wilds.length);
  for (let w = 0; w <= maxWilds; w += 1) {
    const a = count - w;
    if (a < 0 || a > actuals.length) {
      continue;
    }
    combinations(actuals, a, (actualSubset) => {
      combinations(wilds, w, (wildSubset) => {
        const wildIds = new Set<string>();
        for (const card of wildSubset) {
          wildIds.add(card.id);
        }
        callback([...actualSubset, ...wildSubset], wildIds);
      });
    });
  }
}

interface SequenceSlotChoice {
  cards: Card[];
  wildIds: Set<string>;
}

function enumerateSequenceFillings(
  window: number[],
  multiplicity: number,
  cardsByRank: Map<Rank, Card[]>,
  wilds: Card[],
  suit: Suit | null,
  callback: (cardsPerSlot: Card[][]) => void,
): void {
  const slotCount = window.length;
  const ranksForSlots = window.map((value) => valueToRank(value));

  const filled: Card[][] = [];
  const usedWildIds = new Set<string>();

  function backtrack(slot: number): void {
    if (slot === slotCount) {
      callback(filled.map((arr) => [...arr]));
      return;
    }

    const rank = ranksForSlots[slot];
    const actuals = (cardsByRank.get(rank) ?? []).filter(
      (card) => !suit || card.suit === suit,
    );
    const availableWilds = wilds.filter((card) => !usedWildIds.has(card.id));

    enumerateRankCombosWithWildIds(actuals, availableWilds, multiplicity, (cards, wildIds) => {
      filled.push(cards);
      for (const id of wildIds) {
        usedWildIds.add(id);
      }
      backtrack(slot + 1);
      filled.pop();
      for (const id of wildIds) {
        usedWildIds.delete(id);
      }
    });
  }

  backtrack(0);
}

// Fully enumerate every legal concrete play in the hand without dedup. Each
// returned play references concrete Card objects (not abstract templates).
function enumerateConcretePlays(cards: Card[]): Play[] {
  const sorted = [...cards].sort((left, right) => left.id.localeCompare(right.id));
  const wilds = sorted.filter((card) => card.isWild);
  const cardsByRank = new Map<Rank, Card[]>();
  for (const card of sorted) {
    if (card.isWild) {
      continue;
    }
    const list = cardsByRank.get(card.rank) ?? [];
    list.push(card);
    cardsByRank.set(card.rank, list);
  }

  const plays: Play[] = [];

  for (const card of sorted) {
    plays.push(
      createPlay('single', [card], RANK_POWER[getSingleRank(card)], {
        primaryRank: getSingleRank(card),
      }),
    );
  }

  for (const rank of ALL_RANKS) {
    const actuals = cardsByRank.get(rank) ?? [];
    if (isJokerRank(rank)) {
      for (let i = 0; i < actuals.length; i += 1) {
        for (let j = i + 1; j < actuals.length; j += 1) {
          plays.push(
            createPlay('pair', [actuals[i], actuals[j]], RANK_POWER[rank], { primaryRank: rank }),
          );
        }
      }
      continue;
    }

    enumerateRankCombos(actuals, wilds, 2, (combo, wildCount) => {
      if (wildCount === 2 && rank !== 'A') {
        return;
      }
      plays.push(createPlay('pair', combo, RANK_POWER[rank], { primaryRank: rank }));
    });

    enumerateRankCombos(actuals, wilds, 3, (combo, wildCount) => {
      if (wildCount === 3) {
        return;
      }
      plays.push(createPlay('triple', combo, RANK_POWER[rank], { primaryRank: rank }));
    });

    for (let size = 4; size <= 8; size += 1) {
      enumerateRankCombos(actuals, wilds, size, (combo, wildCount) => {
        if (wildCount === size) {
          return;
        }
        plays.push(
          createPlay('bomb', combo, RANK_POWER[rank], {
            bombSize: size,
            primaryRank: rank,
          }),
        );
      });
    }
  }

  const sjs = cardsByRank.get('SJ') ?? [];
  const bjs = cardsByRank.get('BJ') ?? [];
  if (sjs.length >= 2 && bjs.length >= 2) {
    combinations(sjs, 2, (sjSubset) => {
      combinations(bjs, 2, (bjSubset) => {
        plays.push(
          createPlay('joker-bomb', [...sjSubset, ...bjSubset], SPECIAL_TYPE_ORDER, {}),
        );
      });
    });
  }

  for (const tripleRank of NORMAL_RANKS) {
    const tripleActuals = cardsByRank.get(tripleRank) ?? [];
    if (tripleActuals.length === 0 && wilds.length < 1) {
      continue;
    }
    for (const pairRank of ALL_RANKS) {
      if (pairRank === tripleRank) {
        continue;
      }
      const pairActuals = cardsByRank.get(pairRank) ?? [];
      if (isJokerRank(pairRank) && pairActuals.length < 2) {
        continue;
      }

      enumerateRankCombosWithWildIds(tripleActuals, wilds, 3, (tripleCards, tripleWildIds) => {
        if (tripleWildIds.size === 3) {
          return;
        }
        const remainingWilds = wilds.filter((card) => !tripleWildIds.has(card.id));
        if (isJokerRank(pairRank)) {
          for (let i = 0; i < pairActuals.length; i += 1) {
            for (let j = i + 1; j < pairActuals.length; j += 1) {
              plays.push(
                createPlay(
                  'full-house',
                  [...tripleCards, pairActuals[i], pairActuals[j]],
                  RANK_POWER[tripleRank],
                  { primaryRank: tripleRank },
                ),
              );
            }
          }
          return;
        }
        enumerateRankCombos(pairActuals, remainingWilds, 2, (pairCards, pairWildCount) => {
          if (pairWildCount === 2 && pairRank !== 'A') {
            return;
          }
          plays.push(
            createPlay(
              'full-house',
              [...tripleCards, ...pairCards],
              RANK_POWER[tripleRank],
              { primaryRank: tripleRank },
            ),
          );
        });
      });
    }
  }

  // Sequences
  const sequenceConfigs: { windows: number[][]; multiplicity: number; type: Play['type'] }[] = [
    { windows: STRAIGHT_WINDOWS, multiplicity: 1, type: 'straight' },
    { windows: PAIR_RUN_WINDOWS, multiplicity: 2, type: 'pair-run' },
    { windows: TRIPLE_RUN_WINDOWS, multiplicity: 3, type: 'triple-run' },
  ];
  for (const config of sequenceConfigs) {
    for (const window of config.windows) {
      enumerateSequenceFillings(window, config.multiplicity, cardsByRank, wilds, null, (slotCards) => {
        const flat = slotCards.flat();
        plays.push(
          createPlay(config.type, flat, window[window.length - 1], {
            sequence: window,
          }),
        );
      });
    }
  }

  for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as const) {
    for (const window of STRAIGHT_WINDOWS) {
      enumerateSequenceFillings(window, 1, cardsByRank, wilds, suit, (slotCards) => {
        const flat = slotCards.flat();
        plays.push(
          createPlay('straight-flush', flat, window[window.length - 1], {
            sequence: window,
            suit,
          }),
        );
      });
    }
  }

  return plays;
}

export function findBestPartition(cards: Card[], options: FindBestPartitionOptions = {}): PartitionResult {
  const start = Date.now();
  const budget = options.budget ?? AUTO_ARRANGE_BUDGET;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const nodeLimit = options.nodeLimit ?? DEFAULT_NODE_LIMIT;

  if (cards.length === 0) {
    return {
      groups: [],
      plays: [],
      cost: zeroCost(),
      fallbackUsed: false,
      nodeCount: 0,
      elapsedMs: 0,
    };
  }

  if (cards.length > MAX_BITMASK_CARDS) {
    const groups = autoArrangeHandGreedy(cards);
    return {
      groups,
      plays: [],
      cost: zeroCost(),
      fallbackUsed: true,
      nodeCount: 0,
      elapsedMs: Date.now() - start,
    };
  }

  const sortedIds = [...cards].map((card) => card.id).sort((left, right) => left.localeCompare(right));
  const indexById = new Map<string, number>();
  sortedIds.forEach((id, index) => indexById.set(id, index));

  const fullMask = sortedIds.length === 32 ? -1 : ((1 << sortedIds.length) - 1) | 0;

  // Precompute every concrete play once and bucket by its lowest-id card so
  // each search node only iterates plays that could anchor on the current
  // lowest available card.
  const allPlays = enumerateConcretePlays(cards);
  const playsByAnchor: IndexedPlay[][] = sortedIds.map(() => []);
  for (const play of allPlays) {
    let mask = 0;
    let lowestIdx = sortedIds.length;
    let valid = true;
    for (const card of play.cards) {
      const idx = indexById.get(card.id);
      if (idx === undefined) {
        valid = false;
        break;
      }
      mask |= 1 << idx;
      if (idx < lowestIdx) {
        lowestIdx = idx;
      }
    }
    if (!valid) {
      continue;
    }
    const indexed: IndexedPlay = {
      play,
      mask,
      costScore: playCostScore(play, budget),
      costWilds: play.wildCount,
      costPrimary: play.primaryValue,
    };
    playsByAnchor[lowestIdx].push(indexed);
  }

  // Order each anchor's candidates so cheaper plays are tried first; within
  // equal cost prefer fewer wilds and higher primary value (better tiebreaks).
  for (const list of playsByAnchor) {
    list.sort((left, right) => {
      if (left.costScore !== right.costScore) {
        return left.costScore - right.costScore;
      }
      if (left.costWilds !== right.costWilds) {
        return left.costWilds - right.costWilds;
      }
      return right.costPrimary - left.costPrimary;
    });
  }

  // Precompute an admissible lower bound on the cost achievable from any
  // subset: every card must be covered, the cheapest play type covers up to
  // 8 cards (8-bomb), and the maximum special credit available across the
  // full hand is an upper bound on credits available in any subset.
  let maxCreditAvailable = 0;
  for (const indexed of allPlays.map((play) => ({ play, score: playCostScore(play, budget) }))) {
    if (indexed.score < 1) {
      maxCreditAvailable += 1 - indexed.score;
    }
  }

  const memo = new Map<number, SearchEntry | null>();
  let nodeCount = 0;
  let timedOut = false;
  // Track the best complete partition (root → empty) seen so far, so that on
  // timeout we return a full partition rather than collapsing to the legacy
  // specials-first greedy.
  let bestComplete: SearchEntry | null = null;

  function popcount(mask: number): number {
    let value = mask;
    value = value - ((value >>> 1) & 0x55555555);
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    value = (value + (value >>> 4)) & 0x0f0f0f0f;
    return ((value * 0x01010101) >>> 24) & 0x3f;
  }

  function lowerBoundCost(mask: number): number {
    if (mask === 0) {
      return 0;
    }
    // ceil(remaining / 8) regular plays - all possible credit -> lower bound.
    const remaining = popcount(mask);
    const minPlays = Math.ceil(remaining / 8);
    return minPlays - maxCreditAvailable;
  }

  function lowestSetBitIndex(mask: number): number {
    if (mask === 0) {
      return -1;
    }
    let index = 0;
    let cursor = mask & -mask;
    while ((cursor & 1) === 0) {
      cursor >>>= 1;
      index += 1;
    }
    return index;
  }

  function search(mask: number): SearchEntry | null {
    if (mask === 0) {
      return { cost: zeroCost(), plays: [] };
    }

    if (memo.has(mask)) {
      return memo.get(mask) ?? null;
    }

    if (timedOut) {
      return null;
    }

    nodeCount += 1;
    if (nodeCount > nodeLimit || Date.now() - start > timeLimitMs) {
      timedOut = true;
      return null;
    }

    const anchorIndex = lowestSetBitIndex(mask);
    const candidates = playsByAnchor[anchorIndex];

    let best: SearchEntry | null = null;

    for (const indexed of candidates) {
      if ((indexed.mask & mask) !== indexed.mask) {
        continue;
      }
      // Branch & bound: skip plays that cannot improve over the current best.
      if (best) {
        const remainingMask = mask & ~indexed.mask;
        const remainingLB = lowerBoundCost(remainingMask);
        if (indexed.costScore + remainingLB >= best.cost.score) {
          continue;
        }
      }
      const sub = search(mask & ~indexed.mask);
      if (sub === null) {
        if (timedOut) {
          // Bubble up partial best if any: at the root, the caller will use
          // bestComplete; at intermediate masks, return null to cancel.
          break;
        }
        continue;
      }

      const totalCost = addCost(
        {
          score: indexed.costScore,
          wilds: indexed.costWilds,
          primarySum: indexed.costPrimary,
        },
        sub.cost,
      );

      if (!best || compareCost(totalCost, best.cost) < 0) {
        best = {
          cost: totalCost,
          plays: [indexed.play, ...sub.plays],
        };
        if (mask === fullMask) {
          bestComplete = best;
        }
      }
    }

    if (!timedOut) {
      memo.set(mask, best);
    }
    return best;
  }

  const result = search(fullMask);
  const elapsedMs = Date.now() - start;

  // On timeout, prefer any partial root-level partition we found over the
  // legacy specials-first greedy.
  const finalResult = result ?? bestComplete;

  if (!finalResult) {
    const groups = autoArrangeHandGreedy(cards);
    return {
      groups,
      plays: [],
      cost: zeroCost(),
      fallbackUsed: true,
      nodeCount,
      elapsedMs,
    };
  }

  const groups = finalResult.plays
    .filter((play) => play.cards.length >= 2)
    .map((play) => play.cards.map((card) => card.id));

  return {
    groups,
    plays: finalResult.plays,
    cost: finalResult.cost,
    fallbackUsed: timedOut,
    nodeCount,
    elapsedMs,
  };
}

export function autoArrangeHand(cards: Card[]): string[][] {
  if (cards.length < 2) {
    return [];
  }

  const primary = findBestPartition(cards);
  if (!primary.fallbackUsed) {
    return primary.groups;
  }

  // Some 27-card "many-overlap" hands can hit the default budget in the UI
  // thread and fall back to a weaker partition. Retry once with a larger
  // budget so one-click arrange prefers quality over latency in these edge
  // cases.
  return findBestPartition(cards, {
    timeLimitMs: 5_000,
    nodeLimit: 5_000_000,
  }).groups;
}

// Greedy "specials-first" partition kept as a deterministic fallback when the
// search-based partition runs out of time / node budget.
function autoArrangeHandGreedy(cards: Card[]): string[][] {
  if (cards.length < 2) {
    return [];
  }

  const candidates = generateAllPlays(cards)
    .filter((play) => play.cards.length >= 2)
    .sort((left, right) => {
      const gap = scoreAutoArrangePlay(right) - scoreAutoArrangePlay(left);
      if (gap !== 0) {
        return gap;
      }
      const leftKey = left.cards.map((card) => card.id).join('|');
      const rightKey = right.cards.map((card) => card.id).join('|');
      return leftKey.localeCompare(rightKey);
    });

  const claimed = new Set<string>();
  const groups: string[][] = [];

  for (const play of candidates) {
    if (play.cards.some((card) => claimed.has(card.id))) {
      continue;
    }

    for (const card of play.cards) {
      claimed.add(card.id);
    }

    groups.push(play.cards.map((card) => card.id));
  }

  return groups;
}

function scoreAutoArrangePlay(play: Play): number {
  const wildPenalty = play.wildCount * 100;
  const primaryBonus = play.primaryValue * 10;

  if (play.type === 'joker-bomb') {
    return 10_000_000;
  }

  if (play.type === 'straight-flush') {
    return 9_000_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'bomb') {
    return 8_000_000 + (play.bombSize ?? 4) * 10_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'triple-run') {
    return 5_000_000 + play.size * 1_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'pair-run') {
    return 4_000_000 + play.size * 1_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'straight') {
    return 3_000_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'full-house') {
    return 2_000_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'triple') {
    return 1_000_000 + primaryBonus - wildPenalty;
  }

  if (play.type === 'pair') {
    return 500_000 + primaryBonus - wildPenalty;
  }

  return 0;
}

export function usesRankPotentialBomb(hand: Card[], play: Play): boolean {
  if (isSpecialPlay(play)) {
    return false;
  }

  const wildCount = getWildCount(hand);
  const handCounts = countNonWildRanks(hand);
  const playRanks = new Set(play.cards.filter((card) => !card.isWild).map((card) => card.rank));

  return [...playRanks].some((rank) => {
    if (!isNormalRank(rank)) {
      return false;
    }

    return (handCounts.get(rank) ?? 0) + wildCount >= 4;
  });
}

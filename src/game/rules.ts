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

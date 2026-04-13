import {
  ALL_RANKS,
  NORMAL_RANKS,
  RANK_POWER,
  SUIT_NAMES,
  SUIT_SYMBOLS,
  type Card,
  type Rank,
  type Suit,
} from './types';

const STANDARD_SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_ORDER: Record<Suit, number> = {
  joker: 0,
  hearts: 1,
  spades: 2,
  clubs: 3,
  diamonds: 4,
};

export function createDeck(): Card[] {
  const deck: Card[] = [];

  for (const deckIndex of [1, 2] as const) {
    for (const suit of STANDARD_SUITS) {
      for (const rank of NORMAL_RANKS) {
        deck.push({
          id: `${deckIndex}-${suit}-${rank}`,
          deck: deckIndex,
          suit,
          rank,
          isWild: suit === 'hearts' && rank === 'A',
        });
      }
    }

    deck.push({
      id: `${deckIndex}-joker-SJ`,
      deck: deckIndex,
      suit: 'joker',
      rank: 'SJ',
      isWild: false,
    });
    deck.push({
      id: `${deckIndex}-joker-BJ`,
      deck: deckIndex,
      suit: 'joker',
      rank: 'BJ',
      isWild: false,
    });
  }

  return deck;
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

export function dealHands(deck: Card[]): Card[][] {
  return [
    sortHand(deck.slice(0, 27)),
    sortHand(deck.slice(27, 54)),
    sortHand(deck.slice(54, 81)),
    sortHand(deck.slice(81, 108)),
  ];
}

export function sortHand(cards: Card[]): Card[] {
  return [...cards].sort((left, right) => {
    const powerGap = RANK_POWER[right.rank] - RANK_POWER[left.rank];
    if (powerGap !== 0) {
      return powerGap;
    }

    if (left.isWild !== right.isWild) {
      return left.isWild ? -1 : 1;
    }

    const suitGap = SUIT_ORDER[left.suit] - SUIT_ORDER[right.suit];
    if (suitGap !== 0) {
      return suitGap;
    }

    return left.id.localeCompare(right.id);
  });
}

export function getCardRankText(card: Card): string {
  if (card.rank === 'SJ') {
    return 'JOKER';
  }

  if (card.rank === 'BJ') {
    return 'JOKER';
  }

  return card.rank;
}

export function getCardSuitText(card: Card): string {
  if (card.suit === 'joker') {
    return 'Joker';
  }

  return SUIT_SYMBOLS[card.suit];
}

export function getCardAriaLabel(card: Card): string {
  if (card.rank === 'SJ' || card.rank === 'BJ') {
    return getCardRankText(card);
  }

  const suffix = card.isWild ? '（万能）' : '';
  return `${SUIT_NAMES[card.suit]}${card.rank}${suffix}`;
}

export function getCardTone(card: Card): 'red' | 'black' | 'gold' {
  if (card.rank === 'SJ' || card.rank === 'BJ' || card.isWild) {
    return 'gold';
  }

  return card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black';
}

export function getRankText(rank: Rank): string {
  if (rank === 'SJ') {
    return '小王';
  }

  if (rank === 'BJ') {
    return '大王';
  }

  return rank;
}

export function isNormalRank(rank: Rank): rank is (typeof NORMAL_RANKS)[number] {
  return (NORMAL_RANKS as readonly string[]).includes(rank);
}

export function getDistinctRanks(cards: Card[]): Rank[] {
  return [...new Set(cards.map((card) => card.rank))];
}

export function getDistinctNormalRanks(cards: Card[]): Rank[] {
  return [...new Set(cards.map((card) => card.rank).filter((rank) => isNormalRank(rank)))];
}

export function hasRank(cards: Card[], rank: Rank): boolean {
  return cards.some((card) => card.rank === rank);
}

export function isJokerRank(rank: Rank): boolean {
  return rank === 'SJ' || rank === 'BJ';
}

export function getAllRanks(): readonly Rank[] {
  return ALL_RANKS;
}

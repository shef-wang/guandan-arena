import type { ArenaActionOption, ArenaCardView, ArenaPlayView, ArenaTurnInput } from '../../src/arena/types';
import type { PlayType, Rank, Seat, Suit } from '../../src/game/types';

const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', 'SJ', 'BJ'];
const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades', 'joker'];
const PLAY_TYPES: PlayType[] = [
  'single',
  'pair',
  'triple',
  'full-house',
  'straight',
  'pair-run',
  'triple-run',
  'bomb',
  'straight-flush',
  'joker-bomb',
];

const MAX_NORMAL_RANK_COUNT = 8;
const MAX_ACTION_RANK_COUNT = 4;

export interface EncodedTurn {
  stateFeatures: number[];
  actionFeatures: number[][];
}

export function encodeTurnForPolicy(input: ArenaTurnInput): EncodedTurn {
  return {
    stateFeatures: encodeStateFeatures(input),
    actionFeatures: input.legalActions.map((action) => encodeActionFeatures(action, input.hand)),
  };
}

function encodeStateFeatures(input: ArenaTurnInput): number[] {
  const ownRankCounts = countRanks(input.hand, MAX_NORMAL_RANK_COUNT);
  const ownSuitCounts = countSuits(input.hand);
  const seenRankCounts = countRanks(input.publicKnowledge.seenCards, MAX_NORMAL_RANK_COUNT);
  const finishedFlags = input.players.map((player) => (player.finished ? 1 : 0));
  const finishPositions = input.players.map((player) => (player.finishPosition ?? 0) / 4);
  const roundPassFlags = ([0, 1, 2, 3] as const).map((seat) => (input.roundTrace[seat].action === '不出' ? 1 : 0));
  const handCounts = input.players.map((player) => player.handCount / 27);

  return [
    ...ownRankCounts,
    ...ownSuitCounts,
    countWild(input.hand) / 4,
    input.hand.length / 27,
    ...handCounts,
    ...oneHot(input.currentPlayer, 4),
    ...oneHot(input.seat, 4),
    ...encodeOwner(input.currentTablePlay?.owner ?? null),
    ...encodePlayType(input.currentTablePlay?.play ?? null),
    (input.currentTablePlay?.play.size ?? 0) / 8,
    (input.currentTablePlay?.play.primaryValue ?? 0) / 16,
    (input.currentTablePlay?.play.bombSize ?? 0) / 8,
    input.currentTablePlay?.play.usesWild ? 1 : 0,
    (input.currentTablePlay?.play.wildCount ?? 0) / 4,
    ...finishedFlags,
    ...finishPositions,
    ...roundPassFlags,
    ...seenRankCounts,
  ];
}

function encodeActionFeatures(action: ArenaActionOption, hand: ArenaCardView[]): number[] {
  const play = action.play;
  const cards = play?.cards ?? [];
  const rankCounts = countRanks(cards, MAX_ACTION_RANK_COUNT);
  const suitCounts = countSuits(cards);
  const remainingCards = getRemainingCards(action, hand);
  const remainingRankCounts = countRanks(remainingCards, MAX_NORMAL_RANK_COUNT);
  const remainingSuitCounts = countSuits(remainingCards);

  return [
    action.kind === 'pass' ? 1 : 0,
    ...encodeActionType(action),
    (play?.size ?? 0) / 8,
    (play?.primaryValue ?? 0) / 16,
    (play?.bombSize ?? 0) / 8,
    (play?.wildCount ?? 0) / 4,
    play?.usesWild ? 1 : 0,
    ...rankCounts,
    ...suitCounts,
    ...remainingRankCounts,
    ...remainingSuitCounts,
    countWild(remainingCards) / 4,
    remainingCards.length / 27,
  ];
}

function encodeActionType(action: ArenaActionOption): number[] {
  const values = new Array(PLAY_TYPES.length + 1).fill(0);
  if (action.kind === 'pass') {
    values[0] = 1;
    return values;
  }

  const index = PLAY_TYPES.indexOf(action.play!.type);
  values[index + 1] = 1;
  return values;
}

function encodePlayType(play: ArenaPlayView | null): number[] {
  const values = new Array(PLAY_TYPES.length + 1).fill(0);
  if (!play) {
    values[0] = 1;
    return values;
  }

  const index = PLAY_TYPES.indexOf(play.type);
  values[index + 1] = 1;
  return values;
}

function encodeOwner(owner: Seat | null): number[] {
  const values = new Array(5).fill(0);
  if (owner === null) {
    values[0] = 1;
    return values;
  }

  values[owner + 1] = 1;
  return values;
}

function countRanks(cards: ArenaCardView[], maxCount: number): number[] {
  return RANKS.map((rank) => cards.filter((card) => card.rank === rank).length / maxCount);
}

function countSuits(cards: ArenaCardView[]): number[] {
  return SUITS.map((suit) => cards.filter((card) => card.suit === suit).length / 8);
}

function countWild(cards: ArenaCardView[]): number {
  return cards.filter((card) => card.isWild).length;
}

function oneHot(index: number, size: number): number[] {
  return new Array(size).fill(0).map((_, current) => (current === index ? 1 : 0));
}

function getRemainingCards(action: ArenaActionOption, hand: ArenaCardView[]): ArenaCardView[] {
  if (action.kind === 'pass') {
    return hand;
  }

  const playedIds = new Set(action.cardIds);
  return hand.filter((card) => !playedIds.has(card.id));
}

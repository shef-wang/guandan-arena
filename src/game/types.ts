export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades' | 'joker';
export type Rank =
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K'
  | 'A'
  | 'SJ'
  | 'BJ';

export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

export type PlayType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'full-house'
  | 'straight'
  | 'pair-run'
  | 'triple-run'
  | 'bomb'
  | 'straight-flush'
  | 'joker-bomb';

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  deck: 1 | 2;
  isWild: boolean;
}

export interface Play {
  key: string;
  type: PlayType;
  cards: Card[];
  size: number;
  primaryValue: number;
  label: string;
  usesWild: boolean;
  wildCount: number;
  bombSize?: number;
  suit?: Suit;
  sequence?: number[];
}

export interface TablePlay {
  owner: Seat;
  play: Play;
}

export interface SeatTrace {
  play: Play | null;
  action: string;
}

export interface ActionHistoryEntry {
  turn: number;
  seat: Seat;
  action: string;
  play: Play | null;
  handCountAfter: number;
  tableOwnerAfter: Seat | null;
  tablePlayAfter: Play | null;
}

export interface GameResult {
  winnerTeam: Team;
  levelDelta: 1 | 2 | 3;
  placementKey: '12' | '13' | '14' | '23' | '24' | '34';
  badge: string;
  summary: string;
}

export interface PlayerState {
  seat: Seat;
  team: Team;
  name: string;
  isHuman: boolean;
  hand: Card[];
  finished: boolean;
}

export interface GameState {
  players: PlayerState[];
  currentPlayer: Seat;
  starter: Seat;
  tablePlay: TablePlay | null;
  roundTrace: Record<Seat, SeatTrace>;
  actionHistory: ActionHistoryEntry[];
  passedPlayers: Seat[];
  finishOrder: Seat[];
  lastActions: Record<Seat, string>;
  message: string;
  result: GameResult | null;
  winnerTeam: Team | null;
}

export interface AiDecision {
  type: 'play' | 'pass';
  play?: Play;
}

export const NORMAL_RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const;

export const ALL_RANKS = [...NORMAL_RANKS, 'SJ', 'BJ'] as const;

export const SUIT_SYMBOLS: Record<Suit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
  joker: '★',
};

export const SUIT_NAMES: Record<Suit, string> = {
  clubs: '梅花',
  diamonds: '方块',
  hearts: '红桃',
  spades: '黑桃',
  joker: '王牌',
};

export const RANK_POWER: Record<Rank, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
  SJ: 15,
  BJ: 16,
};

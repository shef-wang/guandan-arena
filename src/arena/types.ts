import type { GameResult, GameState, PlayType, Rank, Seat, Suit, Team } from '../game/types';

export interface ArenaCardView {
  id: string;
  suit: Suit;
  rank: Rank;
  deck: 1 | 2;
  isWild: boolean;
}

export interface ArenaPlayView {
  actionId: string;
  type: PlayType;
  label: string;
  size: number;
  primaryValue: number;
  usesWild: boolean;
  wildCount: number;
  bombSize?: number;
  suit?: Suit;
  sequence?: number[];
  cardIds: string[];
  cards: ArenaCardView[];
}

export interface ArenaSeatTraceView {
  action: string;
  play: ArenaPlayView | null;
}

export interface ArenaPlayerView {
  seat: Seat;
  team: Team;
  name: string;
  handCount: number;
  finished: boolean;
  finishPosition: number | null;
  lastAction: string;
  currentRoundAction: string;
}

export interface ArenaPublicActionHistoryEntry {
  turn: number;
  seat: Seat;
  action: string;
  play: ArenaPlayView | null;
  handCountAfter: number;
  tableOwnerAfter: Seat | null;
  tablePlayAfter: ArenaPlayView | null;
}

export interface ArenaPublicKnowledgeView {
  actionHistory: ArenaPublicActionHistoryEntry[];
  seenCards: ArenaCardView[];
  remainingHandCounts: Record<Seat, number>;
}

export interface ArenaRulesSummary {
  trumpRank: 'A';
  wildCard: 'hearts-A';
  notes: string[];
  finishOutcomes: Array<{
    placement: GameResult['placementKey'];
    winnerTeam: Team;
    levelDelta: 1 | 2 | 3;
  }>;
}

export interface ArenaActionOption {
  actionId: string;
  kind: 'play' | 'pass';
  label: string;
  cardIds: string[];
  play: ArenaPlayView | null;
}

export interface ArenaTurnInput {
  knowledgeMode: 'public_history';
  seat: Seat;
  currentPlayer: Seat;
  players: ArenaPlayerView[];
  hand: ArenaCardView[];
  currentTablePlay: {
    owner: Seat;
    play: ArenaPlayView;
  } | null;
  roundTrace: Record<Seat, ArenaSeatTraceView>;
  finishOrder: Seat[];
  message: string;
  result: GameResult | null;
  legalActions: ArenaActionOption[];
  rules: ArenaRulesSummary;
  publicKnowledge: ArenaPublicKnowledgeView;
}

export interface ArenaTurnContext {
  seat: Seat;
  state: GameState;
}

export type ArenaChosenAction =
  | {
      kind: 'pass';
    }
  | {
      kind: 'play';
      actionId: string;
    };

export interface ArenaPromptTurnPayload {
  prompt: string;
  input: ArenaTurnInput;
  context: ArenaTurnContext;
}

export interface ArenaPromptAgentConfig {
  id: string;
  label: string;
  completeTurn: (
    payload: ArenaPromptTurnPayload,
  ) => Promise<string | ArenaChosenAction> | string | ArenaChosenAction;
}

export type AgentType = 'heuristic' | 'openrouter' | 'learned-policy' | 'human' | 'custom';

export interface GuandanArenaAgent {
  id: string;
  label: string;
  agentType: AgentType;
  decideTurn: (
    input: ArenaTurnInput,
    context: ArenaTurnContext,
  ) => Promise<ArenaChosenAction> | ArenaChosenAction;
}

export interface ArenaStepResult {
  seat: Seat;
  input: ArenaTurnInput;
  action: ArenaChosenAction;
  nextState: GameState;
}

export type ArenaSeatAgentRoster =
  | [GuandanArenaAgent, GuandanArenaAgent, GuandanArenaAgent, GuandanArenaAgent]
  | Record<Seat, GuandanArenaAgent>;

export interface ArenaMatchConfig {
  agents: ArenaSeatAgentRoster;
  initialState?: GameState;
}

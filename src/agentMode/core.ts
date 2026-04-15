import { buildArenaTurnInput, applyArenaChosenAction } from '../arena/engine';
import type { ArenaChosenAction, ArenaTurnInput } from '../arena/types';
import { chooseAiAction, type AiProfile } from '../game/ai';
import { createSeededRandom } from '../game/cards';
import { applyPass, applyPlay, createNewGame } from '../game/state';
import type { GameResult, GameState, Seat, Team } from '../game/types';

export interface AgentBatchConfig {
  totalMatches: number;
  playerSeat: Seat;
  opponentProfile: Extract<AiProfile, 'legacy-v1'>;
  baseSeed: number;
  maxTurnsPerGame: number;
}

export interface AgentMatchSummary {
  matchNumber: number;
  seed: number;
  turns: number;
  playerSeat: Seat;
  playerTeam: Team;
  playerWon: boolean;
  signedLevelDelta: -3 | -2 | -1 | 1 | 2 | 3;
  finishOrder: Seat[];
  result: GameResult;
}

export interface AgentBatchAggregate {
  completedMatches: number;
  totalMatches: number;
  wins: number;
  losses: number;
  totalSignedLevelDelta: number;
  averageSignedLevelDelta: number;
  averageTurns: number;
  placementCounts: Record<GameResult['placementKey'], number>;
}

export interface AgentBatchState {
  version: 1;
  config: AgentBatchConfig;
  completedMatches: AgentMatchSummary[];
  currentGame: GameState | null;
  currentSeed: number | null;
}

export interface AgentBatchDecision {
  status: 'awaiting_action' | 'completed';
  batch: AgentBatchState;
  summary: AgentBatchAggregate;
  currentMatchNumber: number | null;
  turnNumber: number | null;
  turnInput: ArenaTurnInput | null;
}

const DEFAULT_CONFIG: AgentBatchConfig = {
  totalMatches: 10,
  playerSeat: 0,
  opponentProfile: 'legacy-v1',
  baseSeed: 20260415,
  maxTurnsPerGame: 500,
};

export function createAgentBatchState(config?: Partial<AgentBatchConfig>): AgentBatchState {
  return {
    version: 1,
    config: normalizeConfig(config),
    completedMatches: [],
    currentGame: null,
    currentSeed: null,
  };
}

export function advanceAgentBatch(batch: AgentBatchState): AgentBatchDecision {
  const working = cloneBatch(batch);

  while (working.completedMatches.length < working.config.totalMatches) {
    if (!working.currentGame) {
      const nextSeed = working.config.baseSeed + working.completedMatches.length;
      working.currentSeed = nextSeed;
      working.currentGame = createNewGame(createSeededRandom(nextSeed));
    }

    let currentGame = working.currentGame;

    while (currentGame && !currentGame.result && currentGame.currentPlayer !== working.config.playerSeat) {
      currentGame = applyHeuristicSeatAction(currentGame, currentGame.currentPlayer, working.config.opponentProfile);
      assertTurnBudget(currentGame, working.config.maxTurnsPerGame);
    }

    if (!currentGame) {
      throw new Error('Internal error: current game unexpectedly missing during batch advance.');
    }

    if (currentGame.result) {
      working.completedMatches.push(summarizeMatch(currentGame, working.currentSeed ?? 0, working.completedMatches.length + 1, working.config.playerSeat));
      working.currentGame = null;
      working.currentSeed = null;
      continue;
    }

    working.currentGame = currentGame;
    const turnInput = buildArenaTurnInput(currentGame, working.config.playerSeat);
    return {
      status: 'awaiting_action',
      batch: working,
      summary: summarizeBatch(working),
      currentMatchNumber: working.completedMatches.length + 1,
      turnNumber: currentGame.actionHistory.length + 1,
      turnInput,
    };
  }

  return {
    status: 'completed',
    batch: working,
    summary: summarizeBatch(working),
    currentMatchNumber: null,
    turnNumber: null,
    turnInput: null,
  };
}

export function applyAgentAction(batch: AgentBatchState, action: ArenaChosenAction): AgentBatchDecision {
  const working = cloneBatch(batch);

  if (!working.currentGame) {
    throw new Error('No active game is waiting for an external action.');
  }

  if (working.currentGame.result) {
    throw new Error('The active game is already complete.');
  }

  if (working.currentGame.currentPlayer !== working.config.playerSeat) {
    throw new Error(`Seat ${working.config.playerSeat} is not the current player.`);
  }

  working.currentGame = applyArenaChosenAction(working.currentGame, working.config.playerSeat, action);
  assertTurnBudget(working.currentGame, working.config.maxTurnsPerGame);
  return advanceAgentBatch(working);
}

export function summarizeBatch(batch: AgentBatchState): AgentBatchAggregate {
  const placementCounts: Record<GameResult['placementKey'], number> = {
    '12': 0,
    '13': 0,
    '14': 0,
    '23': 0,
    '24': 0,
    '34': 0,
  };

  let wins = 0;
  let losses = 0;
  let totalSignedLevelDelta = 0;
  let totalTurns = 0;

  for (const match of batch.completedMatches) {
    placementCounts[match.result.placementKey] += 1;
    totalSignedLevelDelta += match.signedLevelDelta;
    totalTurns += match.turns;

    if (match.playerWon) {
      wins += 1;
    } else {
      losses += 1;
    }
  }

  return {
    completedMatches: batch.completedMatches.length,
    totalMatches: batch.config.totalMatches,
    wins,
    losses,
    totalSignedLevelDelta,
    averageSignedLevelDelta: batch.completedMatches.length > 0 ? totalSignedLevelDelta / batch.completedMatches.length : 0,
    averageTurns: batch.completedMatches.length > 0 ? totalTurns / batch.completedMatches.length : 0,
    placementCounts,
  };
}

function normalizeConfig(config?: Partial<AgentBatchConfig>): AgentBatchConfig {
  const totalMatches = clampInteger(config?.totalMatches ?? DEFAULT_CONFIG.totalMatches, 1, 100);
  const playerSeat = normalizeSeat(config?.playerSeat ?? DEFAULT_CONFIG.playerSeat);
  const baseSeed = Math.max(0, Math.floor(config?.baseSeed ?? DEFAULT_CONFIG.baseSeed));
  const maxTurnsPerGame = clampInteger(config?.maxTurnsPerGame ?? DEFAULT_CONFIG.maxTurnsPerGame, 50, 1000);
  const opponentProfile = config?.opponentProfile === 'legacy-v1' ? 'legacy-v1' : DEFAULT_CONFIG.opponentProfile;

  return {
    totalMatches,
    playerSeat,
    opponentProfile,
    baseSeed,
    maxTurnsPerGame,
  };
}

function cloneBatch(batch: AgentBatchState): AgentBatchState {
  return {
    ...batch,
    config: { ...batch.config },
    completedMatches: [...batch.completedMatches],
  };
}

function summarizeMatch(state: GameState, seed: number, matchNumber: number, playerSeat: Seat): AgentMatchSummary {
  if (!state.result) {
    throw new Error('Cannot summarize a non-terminal game.');
  }

  const playerTeam = teamForSeat(playerSeat);
  const playerWon = state.result.winnerTeam === playerTeam;
  const signedLevelDelta = (playerWon ? state.result.levelDelta : -state.result.levelDelta) as AgentMatchSummary['signedLevelDelta'];

  return {
    matchNumber,
    seed,
    turns: state.actionHistory.length,
    playerSeat,
    playerTeam,
    playerWon,
    signedLevelDelta,
    finishOrder: [...state.finishOrder],
    result: state.result,
  };
}

function applyHeuristicSeatAction(state: GameState, seat: Seat, profile: Extract<AiProfile, 'legacy-v1'>): GameState {
  const decision = chooseAiAction(state, seat, profile);

  if (decision.type === 'pass' || !decision.play) {
    return applyPass(state, seat);
  }

  return applyPlay(state, seat, decision.play);
}

function assertTurnBudget(state: GameState, maxTurnsPerGame: number): void {
  if (!state.result && state.actionHistory.length >= maxTurnsPerGame) {
    throw new Error(`Game exceeded ${maxTurnsPerGame} turns without reaching a terminal result.`);
  }
}

function normalizeSeat(value: number): Seat {
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }

  return 0;
}

function teamForSeat(seat: Seat): Team {
  return seat % 2 === 0 ? 0 : 1;
}

function clampInteger(value: number, min: number, max: number): number {
  const normalized = Math.floor(value);
  return Math.min(max, Math.max(min, Number.isFinite(normalized) ? normalized : min));
}

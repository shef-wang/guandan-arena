import { chooseAiAction, type AiProfile } from '../game/ai';
import { filterLegalPlays, generateAllPlays, sortPlayOptionsForContext } from '../game/rules';
import { applyPass, applyPlay, createNewGame } from '../game/state';
import type { ActionHistoryEntry, Card, GameState, Play, Seat } from '../game/types';
import { formatTurnInputAsPrompt } from './prompt';
import type {
  ArenaActionOption,
  ArenaCardView,
  ArenaChosenAction,
  ArenaMatchConfig,
  ArenaPromptAgentConfig,
  ArenaPublicActionHistoryEntry,
  ArenaPlayView,
  ArenaPlayerView,
  ArenaPublicKnowledgeView,
  ArenaRulesSummary,
  ArenaSeatAgentRoster,
  ArenaSeatTraceView,
  ArenaStepResult,
  ArenaTurnInput,
  GuandanArenaAgent,
} from './types';

export const ARENA_RULES_SUMMARY: ArenaRulesSummary = {
  trumpRank: 'A',
  wildCard: 'hearts-A',
  notes: [
    'Two decks with two jokers per deck.',
    'Seats 0 and 2 are partners. Seats 1 and 3 are partners.',
    'Only hearts A is wild. Other A cards are normal A.',
    'Straights allow 10-J-Q-K-A, A-2-3-4-5, and 2-3-4-5-6. Jokers cannot be inside straights.',
    'Pair runs allow A-A-2-2-3-3. Triple runs allow A-A-A-2-2-2.',
    'Straight flush beats 5-bomb and 4-bomb, but loses to 6-bomb and above.',
    'Bomb order: 4 jokers > 8-bomb > 7-bomb > 6-bomb > straight flush > 5-bomb > 4-bomb > ordinary plays.',
  ],
  finishOutcomes: [
    { placement: '12', winnerTeam: 0, levelDelta: 3 },
    { placement: '13', winnerTeam: 0, levelDelta: 2 },
    { placement: '14', winnerTeam: 0, levelDelta: 1 },
    { placement: '23', winnerTeam: 1, levelDelta: 1 },
    { placement: '24', winnerTeam: 1, levelDelta: 2 },
    { placement: '34', winnerTeam: 1, levelDelta: 3 },
  ],
};

export function createFunctionAgent(config: {
  id: string;
  label: string;
  decideTurn: GuandanArenaAgent['decideTurn'];
}): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    decideTurn: config.decideTurn,
  };
}

export function createHeuristicAgent(config?: { id?: string; label?: string; profile?: AiProfile }): GuandanArenaAgent {
  return {
    id: config?.id ?? 'builtin-heuristic',
    label:
      config?.label ??
      (config?.profile === 'baseline'
        ? 'Builtin Baseline'
        : config?.profile === 'legacy-vR'
          ? 'guandan-ai vR'
        : config?.profile === 'legacy-v1'
          ? 'guandan-ai v1'
          : 'guandan-ai v2 balanced'),
    decideTurn(input, context) {
      const decision = chooseAiAction(context.state, context.seat, config?.profile ?? 'legacy-v1');
      if (decision.type === 'pass' || !decision.play) {
        return { kind: 'pass' };
      }

      return {
        kind: 'play',
        actionId: actionIdForPlay(decision.play),
      };
    },
  };
}

export function createPromptAgent(config: ArenaPromptAgentConfig): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    async decideTurn(input, context) {
      const raw = await config.completeTurn({
        prompt: formatTurnInputAsPrompt(input),
        input,
        context,
      });

      return parseArenaChosenAction(raw, input.legalActions);
    },
  };
}

export class GuandanArenaMatch {
  private state: GameState;
  private readonly agents: Record<Seat, GuandanArenaAgent>;

  constructor(config: ArenaMatchConfig) {
    this.state = config.initialState ?? createNewGame();
    this.agents = normalizeSeatRoster(config.agents);
  }

  getState(): GameState {
    return this.state;
  }

  reset(nextState?: GameState): GameState {
    this.state = nextState ?? createNewGame();
    return this.state;
  }

  setSeatAgent(seat: Seat, agent: GuandanArenaAgent): void {
    this.agents[seat] = agent;
  }

  getTurnInput(seat: Seat = this.state.currentPlayer): ArenaTurnInput {
    return buildArenaTurnInput(this.state, seat);
  }

  stepWithAction(action: ArenaChosenAction, seat: Seat = this.state.currentPlayer): ArenaStepResult {
    if (this.state.result) {
      throw new Error(`Match already finished: ${this.state.result.summary}`);
    }

    const input = buildArenaTurnInput(this.state, seat);
    const normalizedAction = validateArenaChosenAction(action, input.legalActions);
    this.state = applyArenaChosenAction(this.state, seat, normalizedAction);

    return {
      seat,
      input,
      action: normalizedAction,
      nextState: this.state,
    };
  }

  async step(): Promise<ArenaStepResult> {
    if (this.state.result) {
      throw new Error(`Match already finished: ${this.state.result.summary}`);
    }

    const seat = this.state.currentPlayer;
    const agent = this.agents[seat];
    const input = buildArenaTurnInput(this.state, seat);
    const chosenAction = await agent.decideTurn(input, {
      seat,
      state: this.state,
    });

    this.state = applyArenaChosenAction(this.state, seat, chosenAction);

    return {
      seat,
      input,
      action: chosenAction,
      nextState: this.state,
    };
  }

  async runUntilFinished(options?: { maxTurns?: number }): Promise<GameState> {
    const maxTurns = options?.maxTurns ?? 500;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (this.state.result) {
        return this.state;
      }

      await this.step();
    }

    throw new Error(`Match exceeded ${maxTurns} turns without a terminal result.`);
  }
}

export function buildArenaTurnInput(state: GameState, seat: Seat): ArenaTurnInput {
  return {
    knowledgeMode: 'public_history',
    seat,
    currentPlayer: state.currentPlayer,
    players: buildArenaPlayers(state),
    hand: state.players[seat].hand.map(serializeCard),
    currentTablePlay: state.tablePlay
      ? {
          owner: state.tablePlay.owner,
          play: serializePlay(state.tablePlay.play),
        }
      : null,
    roundTrace: buildRoundTrace(state),
    finishOrder: [...state.finishOrder],
    message: state.message,
    result: state.result,
    legalActions: getLegalActionsForSeat(state, seat),
    rules: ARENA_RULES_SUMMARY,
    publicKnowledge: buildPublicKnowledge(state),
  };
}

export function getLegalActionsForSeat(state: GameState, seat: Seat): ArenaActionOption[] {
  if (state.result || state.currentPlayer !== seat) {
    return [];
  }

  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = sortPlayOptionsForContext(
    filterLegalPlays(allPlays, state.tablePlay?.play ?? null),
    state.tablePlay?.play ?? null,
  );
  const playActions = legalPlays.map((play) => toActionOption(play));

  if (!state.tablePlay) {
    return playActions;
  }

  return [
    ...playActions,
    {
      actionId: 'pass',
      kind: 'pass',
      label: '不出',
      cardIds: [],
      play: null,
    },
  ];
}

export function applyArenaChosenAction(state: GameState, seat: Seat, action: ArenaChosenAction): GameState {
  if (state.result) {
    throw new Error(`Match already finished: ${state.result.summary}`);
  }

  if (state.currentPlayer !== seat) {
    throw new Error(`Seat ${seat} cannot act now. Current player is seat ${state.currentPlayer}.`);
  }

  const legalActions = getLegalActionsForSeat(state, seat);

  if (action.kind === 'pass') {
    if (!legalActions.some((item) => item.kind === 'pass')) {
      throw new Error('Pass is not a legal action right now.');
    }

    return applyPass(state, seat);
  }

  const matchedAction = legalActions.find((item) => item.actionId === action.actionId);
  if (!matchedAction || !matchedAction.play) {
    const legalIds = legalActions.map((item) => item.actionId).join(', ');
    throw new Error(`Unknown or illegal actionId "${action.actionId}". Legal actions: ${legalIds}`);
  }

  const matchedPlay = generateConcreteLegalPlays(state.players[seat].hand, state.tablePlay?.play ?? null).find(
    (play) => actionIdForPlay(play) === action.actionId,
  );

  if (!matchedPlay) {
    throw new Error(`Unable to resolve concrete play for actionId "${action.actionId}".`);
  }

  return applyPlay(state, seat, matchedPlay);
}

export function parseArenaChosenAction(
  raw: string | ArenaChosenAction,
  legalActions?: ArenaActionOption[],
): ArenaChosenAction {
  const parsed = typeof raw === 'string' ? parseActionString(raw) : raw;
  return validateArenaChosenAction(parsed, legalActions);
}

export function validateArenaChosenAction(
  action: ArenaChosenAction,
  legalActions?: ArenaActionOption[],
): ArenaChosenAction {
  if (action.kind !== 'pass' && action.kind !== 'play') {
    throw new Error('Chosen action must use kind "pass" or "play".');
  }

  if (action.kind === 'play') {
    if (!action.actionId) {
      throw new Error('Play actions must include actionId.');
    }

    if (legalActions && !legalActions.some((item) => item.kind === 'play' && item.actionId === action.actionId)) {
      const legalIds = legalActions
        .filter((item) => item.kind === 'play')
        .map((item) => item.actionId)
        .join(', ');
      throw new Error(`Illegal play actionId "${action.actionId}". Legal play ids: ${legalIds}`);
    }

    return action;
  }

  if (legalActions && !legalActions.some((item) => item.kind === 'pass')) {
    throw new Error('Pass was returned, but pass is not legal in this position.');
  }

  return action;
}

function generateConcreteLegalPlays(hand: Card[], target: Play | null): Play[] {
  return sortPlayOptionsForContext(filterLegalPlays(generateAllPlays(hand), target), target);
}

function toActionOption(play: Play): ArenaActionOption {
  return {
    actionId: actionIdForPlay(play),
    kind: 'play',
    label: play.label,
    cardIds: play.cards.map((card) => card.id),
    play: serializePlay(play),
  };
}

function buildArenaPlayers(state: GameState): ArenaPlayerView[] {
  return state.players.map((player) => ({
    seat: player.seat,
    team: player.team,
    name: player.name,
    handCount: player.hand.length,
    finished: player.finished,
    finishPosition: state.finishOrder.indexOf(player.seat) === -1 ? null : state.finishOrder.indexOf(player.seat) + 1,
    lastAction: state.lastActions[player.seat],
    currentRoundAction: state.roundTrace[player.seat].action,
  }));
}

function buildRoundTrace(state: GameState): Record<Seat, ArenaSeatTraceView> {
  return {
    0: {
      action: state.roundTrace[0].action,
      play: state.roundTrace[0].play ? serializePlay(state.roundTrace[0].play) : null,
    },
    1: {
      action: state.roundTrace[1].action,
      play: state.roundTrace[1].play ? serializePlay(state.roundTrace[1].play) : null,
    },
    2: {
      action: state.roundTrace[2].action,
      play: state.roundTrace[2].play ? serializePlay(state.roundTrace[2].play) : null,
    },
    3: {
      action: state.roundTrace[3].action,
      play: state.roundTrace[3].play ? serializePlay(state.roundTrace[3].play) : null,
    },
  };
}

function buildPublicKnowledge(state: GameState): ArenaPublicKnowledgeView {
  const actionHistory = state.actionHistory.map(serializeActionHistoryEntry);
  const seenCards = state.actionHistory.flatMap((entry) => (entry.play ? entry.play.cards.map(serializeCard) : []));
  const remainingHandCounts: Record<Seat, number> = {
    0: state.players[0].hand.length,
    1: state.players[1].hand.length,
    2: state.players[2].hand.length,
    3: state.players[3].hand.length,
  };

  return {
    actionHistory,
    seenCards,
    remainingHandCounts,
  };
}

function serializeCard(card: Card): ArenaCardView {
  return {
    id: card.id,
    suit: card.suit,
    rank: card.rank,
    deck: card.deck,
    isWild: card.isWild,
  };
}

function serializePlay(play: Play): ArenaPlayView {
  return {
    actionId: actionIdForPlay(play),
    type: play.type,
    label: play.label,
    size: play.size,
    primaryValue: play.primaryValue,
    usesWild: play.usesWild,
    wildCount: play.wildCount,
    bombSize: play.bombSize,
    suit: play.suit,
    sequence: play.sequence,
    cardIds: play.cards.map((card) => card.id),
    cards: play.cards.map(serializeCard),
  };
}

function serializeActionHistoryEntry(entry: ActionHistoryEntry): ArenaPublicActionHistoryEntry {
  return {
    turn: entry.turn,
    seat: entry.seat,
    action: entry.action,
    play: entry.play ? serializePlay(entry.play) : null,
    handCountAfter: entry.handCountAfter,
    tableOwnerAfter: entry.tableOwnerAfter,
    tablePlayAfter: entry.tablePlayAfter ? serializePlay(entry.tablePlayAfter) : null,
  };
}

function normalizeSeatRoster(roster: ArenaSeatAgentRoster): Record<Seat, GuandanArenaAgent> {
  if (Array.isArray(roster)) {
    return {
      0: roster[0],
      1: roster[1],
      2: roster[2],
      3: roster[3],
    };
  }

  return roster;
}

function actionIdForPlay(play: Play): string {
  return `play:${play.key}`;
}

function parseActionString(raw: string): ArenaChosenAction {
  const trimmed = raw.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const jsonCandidate = extractJSONObject(withoutFence);
  const parsed = JSON.parse(jsonCandidate) as ArenaChosenAction;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Model output did not parse into an action object.');
  }

  return parsed;
}

function extractJSONObject(raw: string): string {
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error(`Expected JSON object in model output, received: ${raw}`);
  }

  return raw.slice(firstBrace, lastBrace + 1);
}

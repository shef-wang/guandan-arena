import { createDeck, dealHands, sortHand } from './cards';
import { sameTeam } from './rules';
import type { ActionHistoryEntry, GameResult, GameState, Play, PlayerState, Seat, SeatTrace, Team } from './types';
import { shuffle } from './cards';

const PLAYER_NAMES: Record<Seat, string> = {
  0: '你',
  1: '右侧 AI',
  2: '队友 AI',
  3: '左侧 AI',
};

export function createNewGame(random: () => number = Math.random): GameState {
  const deck = shuffle(createDeck(), random);
  const hands = dealHands(deck);
  const starter = Math.floor(random() * 4) as Seat;

  const players = hands.map<PlayerState>((hand, seat) => ({
    seat: seat as Seat,
    team: seat % 2 === 0 ? 0 : 1,
    name: PLAYER_NAMES[seat as Seat],
    isHuman: seat === 0,
    hand,
    finished: false,
  }));

  return {
    players,
    currentPlayer: starter,
    starter,
    tablePlay: null,
    roundTrace: createEmptyRoundTrace(),
    actionHistory: [],
    passedPlayers: [],
    finishOrder: [],
    lastActions: {
      0: starter === 0 ? '你先手' : '等待出牌',
      1: starter === 1 ? '右侧 AI 先手' : '等待出牌',
      2: starter === 2 ? '队友 AI 先手' : '等待出牌',
      3: starter === 3 ? '左侧 AI 先手' : '等待出牌',
    },
    message: `${PLAYER_NAMES[starter]}先手，主牌固定为 A，红桃 A 为万能牌。`,
    result: null,
    winnerTeam: null,
  };
}

export function applyPlay(state: GameState, seat: Seat, play: Play): GameState {
  const players = state.players.map((player) => {
    if (player.seat !== seat) {
      return player;
    }

    const playedIds = new Set(play.cards.map((card) => card.id));
    const nextHand = sortHand(player.hand.filter((card) => !playedIds.has(card.id)));

    return {
      ...player,
      hand: nextHand,
      finished: nextHand.length === 0,
    };
  });

  const actingPlayer = players[seat];
  const updatedFinishOrder = actingPlayer.finished && !state.finishOrder.includes(seat) ? [...state.finishOrder, seat] : state.finishOrder;
  const resolution = resolveGameResult(players, updatedFinishOrder);
  const lastActions = {
    ...state.lastActions,
    [seat]: actingPlayer.finished ? `出完：${play.label}` : `打出：${play.label}`,
  };
  const roundTrace = seat === 0 ? createEmptyRoundTrace() : cloneRoundTrace(state.roundTrace);
  roundTrace[seat] = {
    play,
    action: actingPlayer.finished ? `出完 ${play.label}` : play.label,
  };

  const nextState: GameState = {
    ...state,
    players,
    tablePlay: { owner: seat, play },
    roundTrace,
    actionHistory: appendActionHistory(state.actionHistory, {
      turn: state.actionHistory.length + 1,
      seat,
      action: actingPlayer.finished ? `出完 ${play.label}` : `打出 ${play.label}`,
      play,
      handCountAfter: actingPlayer.hand.length,
      tableOwnerAfter: seat,
      tablePlayAfter: play,
    }),
    passedPlayers: [],
    finishOrder: resolution.finishOrder,
    lastActions,
    message: actingPlayer.finished
      ? `${actingPlayer.name}打出 ${play.label} 并出完手牌。`
      : `${actingPlayer.name}打出 ${play.label}。`,
    result: resolution.result,
    winnerTeam: resolution.result?.winnerTeam ?? null,
  };

  if (resolution.result) {
    return {
      ...nextState,
      message: resolution.result.summary,
    };
  }

  return {
    ...nextState,
    currentPlayer: getNextActiveSeat(nextState.players, seat),
  };
}

export function applyPass(state: GameState, seat: Seat): GameState {
  if (!state.tablePlay) {
    return state;
  }

  const passedPlayers = [...state.passedPlayers, seat];
  const lastActions = {
    ...state.lastActions,
    [seat]: '不出',
  };
  const roundTrace = cloneRoundTrace(state.roundTrace);
  roundTrace[seat] = {
    play: null,
    action: '不出',
  };

  const activeOpponents = state.players.filter((player) => !player.finished && player.seat !== state.tablePlay?.owner);
  if (passedPlayers.length >= activeOpponents.length) {
    const leadSeat = getLeadSeatAfterTrick(state.players, state.tablePlay.owner);
    return {
      ...state,
      tablePlay: null,
      roundTrace,
      actionHistory: appendActionHistory(state.actionHistory, {
        turn: state.actionHistory.length + 1,
        seat,
        action: '不出',
        play: null,
        handCountAfter: state.players[seat].hand.length,
        tableOwnerAfter: null,
        tablePlayAfter: null,
      }),
      passedPlayers: [],
      currentPlayer: leadSeat,
      lastActions,
      message: `${state.players[state.tablePlay.owner].name}收下这一墩，由 ${state.players[leadSeat].name} 重新领出。`,
    };
  }

  return {
    ...state,
    roundTrace,
    actionHistory: appendActionHistory(state.actionHistory, {
      turn: state.actionHistory.length + 1,
      seat,
      action: '不出',
      play: null,
      handCountAfter: state.players[seat].hand.length,
      tableOwnerAfter: state.tablePlay.owner,
      tablePlayAfter: state.tablePlay.play,
    }),
    passedPlayers,
    currentPlayer: getNextActiveSeat(state.players, seat),
    lastActions,
    message: `${state.players[seat].name}选择不出。`,
  };
}

export function getNextActiveSeat(players: PlayerState[], currentSeat: Seat): Seat {
  let nextSeat = currentSeat;

  for (let steps = 0; steps < 4; steps += 1) {
    nextSeat = ((nextSeat + 1) % 4) as Seat;
    if (!players[nextSeat].finished) {
      return nextSeat;
    }
  }

  return currentSeat;
}

function getLeadSeatAfterTrick(players: PlayerState[], owner: Seat): Seat {
  if (!players[owner].finished) {
    return owner;
  }

  const partner = ((owner + 2) % 4) as Seat;
  if (!players[partner].finished) {
    return partner;
  }

  return getNextActiveSeat(players, owner);
}

export function getSeatStatus(state: GameState, seat: Seat): string {
  const index = state.finishOrder.indexOf(seat);
  if (index !== -1) {
    return `${index + 1} 位离手`;
  }

  const player = state.players[seat];
  if (state.currentPlayer === seat && state.winnerTeam === null) {
    return '思考中';
  }

  return state.lastActions[seat];
}

export function getTeamName(seat: Seat): string {
  return sameTeam(seat, 0) ? '我方' : '对手';
}

function createEmptyRoundTrace(): Record<Seat, SeatTrace> {
  return {
    0: { play: null, action: '' },
    1: { play: null, action: '' },
    2: { play: null, action: '' },
    3: { play: null, action: '' },
  };
}

function cloneRoundTrace(roundTrace: Record<Seat, SeatTrace>): Record<Seat, SeatTrace> {
  return {
    0: { ...roundTrace[0] },
    1: { ...roundTrace[1] },
    2: { ...roundTrace[2] },
    3: { ...roundTrace[3] },
  };
}

function appendActionHistory(history: ActionHistoryEntry[], entry: ActionHistoryEntry): ActionHistoryEntry[] {
  return [...history, entry];
}

function resolveGameResult(
  players: PlayerState[],
  finishOrder: Seat[],
): {
  finishOrder: Seat[];
  result: GameResult | null;
} {
  if (finishOrder.length < 2) {
    return {
      finishOrder,
      result: null,
    };
  }

  let resolvedOrder = [...finishOrder];

  if (finishOrder.length === 2) {
    if (!sameTeam(finishOrder[0], finishOrder[1])) {
      return {
        finishOrder: resolvedOrder,
        result: null,
      };
    }
  } else if (finishOrder.length >= 3) {
    const remainingSeats = players.map((player) => player.seat).filter((seat) => !finishOrder.includes(seat));
    if (remainingSeats.length === 1) {
      resolvedOrder = [...finishOrder, remainingSeats[0]];
    }
  }

  const ourPositions = ([0, 2] as const)
    .map((seat) => resolvedOrder.indexOf(seat) + 1)
    .filter((position) => position > 0)
    .sort((left, right) => left - right);

  if (ourPositions.length !== 2) {
    return {
      finishOrder: resolvedOrder,
      result: null,
    };
  }

  const placementKey = `${ourPositions[0]}${ourPositions[1]}` as GameResult['placementKey'];
  const resultMap: Record<GameResult['placementKey'], { winnerTeam: Team; levelDelta: 1 | 2 | 3 }> = {
    '12': { winnerTeam: 0, levelDelta: 3 },
    '13': { winnerTeam: 0, levelDelta: 2 },
    '14': { winnerTeam: 0, levelDelta: 1 },
    '23': { winnerTeam: 1, levelDelta: 1 },
    '24': { winnerTeam: 1, levelDelta: 2 },
    '34': { winnerTeam: 1, levelDelta: 3 },
  };

  const mapped = resultMap[placementKey];
  const badge = mapped.winnerTeam === 0 ? `你方升 ${mapped.levelDelta} 级` : `对方升 ${mapped.levelDelta} 级`;
  const summary =
    mapped.winnerTeam === 0
      ? `你和队友分列 ${placementKey[0]}${placementKey[1]}，你方升 ${mapped.levelDelta} 级。`
      : `你和队友分列 ${placementKey[0]}${placementKey[1]}，对方升 ${mapped.levelDelta} 级。`;

  return {
    finishOrder: resolvedOrder,
    result: {
      winnerTeam: mapped.winnerTeam,
      levelDelta: mapped.levelDelta,
      placementKey,
      badge,
      summary,
    },
  };
}

"use strict";

// src/game/types.ts
var NORMAL_RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A"
];
var ALL_RANKS = [...NORMAL_RANKS, "SJ", "BJ"];
var RANK_POWER = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
  SJ: 15,
  BJ: 16
};

// src/game/cards.ts
var STANDARD_SUITS = ["clubs", "diamonds", "hearts", "spades"];
var SUIT_ORDER = {
  joker: 0,
  hearts: 1,
  spades: 2,
  clubs: 3,
  diamonds: 4
};
function createDeck() {
  const deck = [];
  for (const deckIndex of [1, 2]) {
    for (const suit of STANDARD_SUITS) {
      for (const rank of NORMAL_RANKS) {
        deck.push({
          id: `${deckIndex}-${suit}-${rank}`,
          deck: deckIndex,
          suit,
          rank,
          isWild: suit === "hearts" && rank === "A"
        });
      }
    }
    deck.push({
      id: `${deckIndex}-joker-SJ`,
      deck: deckIndex,
      suit: "joker",
      rank: "SJ",
      isWild: false
    });
    deck.push({
      id: `${deckIndex}-joker-BJ`,
      deck: deckIndex,
      suit: "joker",
      rank: "BJ",
      isWild: false
    });
  }
  return deck;
}
function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = state * 1664525 + 1013904223 >>> 0;
    return state / 4294967296;
  };
}
function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
function dealHands(deck) {
  return [
    sortHand(deck.slice(0, 27)),
    sortHand(deck.slice(27, 54)),
    sortHand(deck.slice(54, 81)),
    sortHand(deck.slice(81, 108))
  ];
}
function sortHand(cards) {
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
function getRankText(rank) {
  if (rank === "SJ") {
    return "\u5C0F\u738B";
  }
  if (rank === "BJ") {
    return "\u5927\u738B";
  }
  return rank;
}
function isNormalRank(rank) {
  return NORMAL_RANKS.includes(rank);
}
function isJokerRank(rank) {
  return rank === "SJ" || rank === "BJ";
}

// src/game/rules.ts
var STRAIGHT_WINDOWS = buildWindows(5);
var PAIR_RUN_WINDOWS = buildWindows(3);
var TRIPLE_RUN_WINDOWS = buildWindows(2);
var SPECIAL_TYPE_ORDER = 1e6;
function sameTeam(left, right) {
  return left % 2 === right % 2;
}
function isSpecialPlay(play) {
  return play.type === "bomb" || play.type === "straight-flush" || play.type === "joker-bomb";
}
function generateAllPlays(hand) {
  const plays = /* @__PURE__ */ new Map();
  const rankGroups = groupCardsByRank(hand.filter((card) => !card.isWild));
  const wildCards = hand.filter((card) => card.isWild);
  for (const rank of ALL_RANKS) {
    const actualCount = rankGroups.get(rank)?.length ?? 0;
    if (actualCount === 0 && rank !== "A") {
      continue;
    }
    const single = pickCardsForRequirements(hand, [{ rank, count: 1 }]);
    if (!single) {
      continue;
    }
    addPlay(
      plays,
      createPlay("single", single, RANK_POWER[rank], {
        primaryRank: rank
      })
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
            createPlay("pair", pair, RANK_POWER[rank], {
              primaryRank: rank
            })
          );
        }
      }
      continue;
    }
    const totalCount = actualCount + wildCards.length;
    if (totalCount >= 2 && (actualCount > 0 || rank === "A")) {
      const pair = pickCardsForRequirements(hand, [{ rank, count: 2 }]);
      if (pair) {
        addPlay(
          plays,
          createPlay("pair", pair, RANK_POWER[rank], {
            primaryRank: rank
          })
        );
      }
    }
    if (totalCount >= 3 && actualCount > 0) {
      const triple = pickCardsForRequirements(hand, [{ rank, count: 3 }]);
      if (triple) {
        addPlay(
          plays,
          createPlay("triple", triple, RANK_POWER[rank], {
            primaryRank: rank
          })
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
          createPlay("bomb", bomb, RANK_POWER[rank], {
            bombSize,
            primaryRank: rank
          })
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
        { rank: pairRank, count: 2 }
      ]);
      if (!fullHouse) {
        continue;
      }
      addPlay(
        plays,
        createPlay("full-house", fullHouse, RANK_POWER[tripleRank], {
          primaryRank: tripleRank
        })
      );
    }
  }
  addGeneratedSequences(plays, hand, STRAIGHT_WINDOWS, 1, "straight");
  addGeneratedSequences(plays, hand, PAIR_RUN_WINDOWS, 2, "pair-run");
  addGeneratedSequences(plays, hand, TRIPLE_RUN_WINDOWS, 3, "triple-run");
  addGeneratedStraightFlushes(plays, hand);
  if ((rankGroups.get("SJ")?.length ?? 0) === 2 && (rankGroups.get("BJ")?.length ?? 0) === 2) {
    const jokerBomb = pickCardsForRequirements(hand, [
      { rank: "SJ", count: 2 },
      { rank: "BJ", count: 2 }
    ]);
    if (jokerBomb) {
      addPlay(plays, createPlay("joker-bomb", jokerBomb, SPECIAL_TYPE_ORDER, {}));
    }
  }
  return [...plays.values()].sort(comparePlayPreference);
}
function filterLegalPlays(plays, target) {
  if (!target) {
    return [...plays];
  }
  return plays.filter((play) => beats(play, target));
}
function sortPlayOptionsForContext(plays, target) {
  return [...plays].sort((left, right) => {
    const leftScore = getPlaySelectionWeight(left, target);
    const rightScore = getPlaySelectionWeight(right, target);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return comparePlayPreference(left, right);
  });
}
function beats(challenger, target) {
  if (challenger.type === target.type) {
    if (challenger.type === "joker-bomb") {
      return false;
    }
    if (challenger.type === "bomb") {
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
  if (challenger.type === "joker-bomb") {
    return target.type !== "joker-bomb";
  }
  if (target.type === "joker-bomb") {
    return false;
  }
  if (challenger.type === "straight-flush") {
    if (target.type === "straight-flush") {
      return challenger.primaryValue > target.primaryValue;
    }
    if (target.type === "bomb") {
      return (target.bombSize ?? 0) <= 5;
    }
    return true;
  }
  if (challenger.type === "bomb") {
    if (!isSpecialPlay(target)) {
      return true;
    }
    if (target.type === "straight-flush") {
      return (challenger.bombSize ?? 0) >= 6;
    }
  }
  return false;
}
function addGeneratedSequences(plays, hand, windows, multiplicity, type) {
  for (const window of windows) {
    const requirements = window.map((value) => ({
      rank: valueToRank(value),
      count: multiplicity
    }));
    const cards = pickCardsForRequirements(hand, requirements);
    if (!cards) {
      continue;
    }
    addPlay(
      plays,
      createPlay(type, cards, window[window.length - 1], {
        sequence: window
      })
    );
  }
}
function addGeneratedStraightFlushes(plays, hand) {
  for (const suit of ["clubs", "diamonds", "hearts", "spades"]) {
    for (const window of STRAIGHT_WINDOWS) {
      const requirements = window.map((value) => ({
        rank: valueToRank(value),
        count: 1,
        suit
      }));
      const cards = pickCardsForRequirements(hand, requirements);
      if (!cards) {
        continue;
      }
      addPlay(
        plays,
        createPlay("straight-flush", cards, window[window.length - 1], {
          sequence: window,
          suit
        })
      );
    }
  }
}
function pickCardsForRequirements(hand, requirements) {
  const selected = [];
  const usedIds = /* @__PURE__ */ new Set();
  const wildCards = hand.filter((card) => card.isWild);
  for (const requirement of requirements) {
    const actualMatches = hand.filter(
      (card) => !card.isWild && !usedIds.has(card.id) && card.rank === requirement.rank && (!requirement.suit || card.suit === requirement.suit)
    ).slice(0, requirement.count);
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
function addPlay(plays, play) {
  const existing = plays.get(play.key);
  if (!existing || compareConcreteCost(play, existing) < 0) {
    plays.set(play.key, play);
  }
}
function createPlay(type, cards, primaryValue, options) {
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
    sequence: options.sequence
  };
}
function sortPlayCardsForDisplay(type, cards, sequence) {
  const decorated = cards.map((card, index) => ({ card, index }));
  if (type === "straight" || type === "pair-run" || type === "triple-run" || type === "straight-flush") {
    const sequenceOrder = new Map(
      (sequence ?? []).map((value, index) => [valueToRank(value), index])
    );
    return decorated.sort((left, right) => {
      const leftOrder = sequenceOrder.get(left.card.isWild ? "A" : left.card.rank) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = sequenceOrder.get(right.card.isWild ? "A" : right.card.rank) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.index - right.index;
    }).map(({ card }) => card);
  }
  return [...cards];
}
function buildPlayKey(type, primaryValue, bombSize, suit) {
  return [type, primaryValue, bombSize ?? 0, suit ?? "none"].join(":");
}
function buildPlayLabel(type, primaryValue, bombSize, primaryRank, sequence) {
  if (type === "joker-bomb") {
    return "\u56DB\u738B\u70B8";
  }
  if (type === "straight") {
    return `\u987A\u5B50 ${describeSequence(sequence)}`;
  }
  if (type === "pair-run") {
    return `\u8FDE\u5BF9 ${describeSequence(sequence)}`;
  }
  if (type === "triple-run") {
    return `\u94A2\u677F ${describeSequence(sequence)}`;
  }
  if (type === "straight-flush") {
    return `\u540C\u82B1\u987A ${describeSequence(sequence)}`;
  }
  if (type === "bomb") {
    return `${bombSize} \u5F20\u70B8 ${getRankText(primaryRank ?? valueToRank(primaryValue))}`;
  }
  const rankText = getRankText(primaryRank ?? valueToRank(primaryValue));
  const nameMap = {
    single: "\u5355\u5F20",
    pair: "\u5BF9\u5B50",
    triple: "\u4E09\u5F20",
    "full-house": "\u4E09\u5E26\u4E8C"
  };
  return `${nameMap[type]} ${rankText}`;
}
function describeSequence(sequence) {
  if (!sequence || sequence.length === 0) {
    return "";
  }
  return sequence.map((value) => getRankText(valueToRank(value))).join("-");
}
function buildWindows(length) {
  const windows = [];
  for (let start = 1; start <= 15 - length; start += 1) {
    windows.push(Array.from({ length }, (_, offset) => start + offset));
  }
  return windows;
}
function valueToRank(value) {
  if (value === 1 || value === 14) {
    return "A";
  }
  if (value >= 2 && value <= 10) {
    return String(value);
  }
  if (value === 11) {
    return "J";
  }
  if (value === 12) {
    return "Q";
  }
  if (value === 13) {
    return "K";
  }
  return "A";
}
function getPlaySelectionWeight(play, target) {
  const specialWeight = getSpecialWeight(play);
  if (!target) {
    return specialWeight * 1e3 + play.primaryValue * 10 + play.wildCount;
  }
  return specialWeight * 1e3 + play.primaryValue * 10 + play.wildCount;
}
function getSpecialWeight(play) {
  if (!isSpecialPlay(play)) {
    const typeWeight = {
      single: 1,
      pair: 2,
      triple: 3,
      "full-house": 4,
      straight: 5,
      "pair-run": 6,
      "triple-run": 7
    };
    return typeWeight[play.type];
  }
  if (play.type === "joker-bomb") {
    return 99;
  }
  if (play.type === "straight-flush") {
    return 53;
  }
  return 40 + (play.bombSize ?? 0);
}
function compareConcreteCost(left, right) {
  if (left.wildCount !== right.wildCount) {
    return left.wildCount - right.wildCount;
  }
  const leftPower = left.cards.reduce((total, card) => total + RANK_POWER[card.rank], 0);
  const rightPower = right.cards.reduce((total, card) => total + RANK_POWER[card.rank], 0);
  if (leftPower !== rightPower) {
    return leftPower - rightPower;
  }
  return left.cards.map((card) => card.id).join("|").localeCompare(right.cards.map((card) => card.id).join("|"));
}
function comparePlayPreference(left, right) {
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
function countNonWildRanks(cards) {
  const counts = /* @__PURE__ */ new Map();
  for (const card of cards) {
    if (card.isWild) {
      continue;
    }
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }
  return counts;
}
function groupCardsByRank(cards) {
  const groups = /* @__PURE__ */ new Map();
  for (const card of cards) {
    const group = groups.get(card.rank) ?? [];
    group.push(card);
    groups.set(card.rank, group);
  }
  return groups;
}
function getWildCount(cards) {
  return cards.filter((card) => card.isWild).length;
}
function usesRankPotentialBomb(hand, play) {
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

// src/game/state.ts
var PLAYER_NAMES = {
  0: "\u4F60",
  1: "\u53F3\u4FA7 AI",
  2: "\u961F\u53CB AI",
  3: "\u5DE6\u4FA7 AI"
};
function createNewGame(random = Math.random) {
  const deck = shuffle(createDeck(), random);
  const hands = dealHands(deck);
  const starter = Math.floor(random() * 4);
  const players = hands.map((hand, seat) => ({
    seat,
    team: seat % 2 === 0 ? 0 : 1,
    name: PLAYER_NAMES[seat],
    isHuman: seat === 0,
    hand,
    finished: false
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
      0: starter === 0 ? "\u4F60\u5148\u624B" : "\u7B49\u5F85\u51FA\u724C",
      1: starter === 1 ? "\u53F3\u4FA7 AI \u5148\u624B" : "\u7B49\u5F85\u51FA\u724C",
      2: starter === 2 ? "\u961F\u53CB AI \u5148\u624B" : "\u7B49\u5F85\u51FA\u724C",
      3: starter === 3 ? "\u5DE6\u4FA7 AI \u5148\u624B" : "\u7B49\u5F85\u51FA\u724C"
    },
    message: `${PLAYER_NAMES[starter]}\u5148\u624B\uFF0C\u4E3B\u724C\u56FA\u5B9A\u4E3A A\uFF0C\u7EA2\u6843 A \u4E3A\u4E07\u80FD\u724C\u3002`,
    result: null,
    winnerTeam: null
  };
}
function applyPlay(state, seat, play) {
  const players = state.players.map((player) => {
    if (player.seat !== seat) {
      return player;
    }
    const playedIds = new Set(play.cards.map((card) => card.id));
    const nextHand = sortHand(player.hand.filter((card) => !playedIds.has(card.id)));
    return {
      ...player,
      hand: nextHand,
      finished: nextHand.length === 0
    };
  });
  const actingPlayer = players[seat];
  const updatedFinishOrder = actingPlayer.finished && !state.finishOrder.includes(seat) ? [...state.finishOrder, seat] : state.finishOrder;
  const resolution = resolveGameResult(players, updatedFinishOrder);
  const lastActions = {
    ...state.lastActions,
    [seat]: actingPlayer.finished ? `\u51FA\u5B8C\uFF1A${play.label}` : `\u6253\u51FA\uFF1A${play.label}`
  };
  const roundTrace = seat === 0 ? createEmptyRoundTrace() : cloneRoundTrace(state.roundTrace);
  roundTrace[seat] = {
    play,
    action: actingPlayer.finished ? `\u51FA\u5B8C ${play.label}` : play.label
  };
  const nextState = {
    ...state,
    players,
    tablePlay: { owner: seat, play },
    roundTrace,
    actionHistory: appendActionHistory(state.actionHistory, {
      turn: state.actionHistory.length + 1,
      seat,
      action: actingPlayer.finished ? `\u51FA\u5B8C ${play.label}` : `\u6253\u51FA ${play.label}`,
      play,
      handCountAfter: actingPlayer.hand.length,
      tableOwnerAfter: seat,
      tablePlayAfter: play
    }),
    passedPlayers: [],
    finishOrder: resolution.finishOrder,
    lastActions,
    message: actingPlayer.finished ? `${actingPlayer.name}\u6253\u51FA ${play.label} \u5E76\u51FA\u5B8C\u624B\u724C\u3002` : `${actingPlayer.name}\u6253\u51FA ${play.label}\u3002`,
    result: resolution.result,
    winnerTeam: resolution.result?.winnerTeam ?? null
  };
  if (resolution.result) {
    return {
      ...nextState,
      message: resolution.result.summary
    };
  }
  return {
    ...nextState,
    currentPlayer: getNextActiveSeat(nextState.players, seat)
  };
}
function applyPass(state, seat) {
  if (!state.tablePlay) {
    return state;
  }
  const passedPlayers = [...state.passedPlayers, seat];
  const lastActions = {
    ...state.lastActions,
    [seat]: "\u4E0D\u51FA"
  };
  const roundTrace = cloneRoundTrace(state.roundTrace);
  roundTrace[seat] = {
    play: null,
    action: "\u4E0D\u51FA"
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
        action: "\u4E0D\u51FA",
        play: null,
        handCountAfter: state.players[seat].hand.length,
        tableOwnerAfter: null,
        tablePlayAfter: null
      }),
      passedPlayers: [],
      currentPlayer: leadSeat,
      lastActions,
      message: `${state.players[state.tablePlay.owner].name}\u6536\u4E0B\u8FD9\u4E00\u58A9\uFF0C\u7531 ${state.players[leadSeat].name} \u91CD\u65B0\u9886\u51FA\u3002`
    };
  }
  return {
    ...state,
    roundTrace,
    actionHistory: appendActionHistory(state.actionHistory, {
      turn: state.actionHistory.length + 1,
      seat,
      action: "\u4E0D\u51FA",
      play: null,
      handCountAfter: state.players[seat].hand.length,
      tableOwnerAfter: state.tablePlay.owner,
      tablePlayAfter: state.tablePlay.play
    }),
    passedPlayers,
    currentPlayer: getNextActiveSeat(state.players, seat),
    lastActions,
    message: `${state.players[seat].name}\u9009\u62E9\u4E0D\u51FA\u3002`
  };
}
function getNextActiveSeat(players, currentSeat) {
  let nextSeat = currentSeat;
  for (let steps = 0; steps < 4; steps += 1) {
    nextSeat = (nextSeat + 1) % 4;
    if (!players[nextSeat].finished) {
      return nextSeat;
    }
  }
  return currentSeat;
}
function getLeadSeatAfterTrick(players, owner) {
  if (!players[owner].finished) {
    return owner;
  }
  const partner = (owner + 2) % 4;
  if (!players[partner].finished) {
    return partner;
  }
  return getNextActiveSeat(players, owner);
}
function createEmptyRoundTrace() {
  return {
    0: { play: null, action: "" },
    1: { play: null, action: "" },
    2: { play: null, action: "" },
    3: { play: null, action: "" }
  };
}
function cloneRoundTrace(roundTrace) {
  return {
    0: { ...roundTrace[0] },
    1: { ...roundTrace[1] },
    2: { ...roundTrace[2] },
    3: { ...roundTrace[3] }
  };
}
function appendActionHistory(history, entry) {
  return [...history, entry];
}
function resolveGameResult(players, finishOrder) {
  if (finishOrder.length < 2) {
    return {
      finishOrder,
      result: null
    };
  }
  let resolvedOrder = [...finishOrder];
  if (finishOrder.length === 2) {
    if (!sameTeam(finishOrder[0], finishOrder[1])) {
      return {
        finishOrder: resolvedOrder,
        result: null
      };
    }
    const remainingSeats = players.map((player) => player.seat).filter((seat) => !finishOrder.includes(seat));
    if (remainingSeats.length === 2) {
      resolvedOrder = [...finishOrder, ...remainingSeats];
    }
  } else if (finishOrder.length >= 3) {
    const remainingSeats = players.map((player) => player.seat).filter((seat) => !finishOrder.includes(seat));
    if (remainingSeats.length === 1) {
      resolvedOrder = [...finishOrder, remainingSeats[0]];
    }
  }
  const ourPositions = [0, 2].map((seat) => resolvedOrder.indexOf(seat) + 1).filter((position) => position > 0).sort((left, right) => left - right);
  if (ourPositions.length !== 2) {
    return {
      finishOrder: resolvedOrder,
      result: null
    };
  }
  const placementKey = `${ourPositions[0]}${ourPositions[1]}`;
  const resultMap = {
    "12": { winnerTeam: 0, levelDelta: 3 },
    "13": { winnerTeam: 0, levelDelta: 2 },
    "14": { winnerTeam: 0, levelDelta: 1 },
    "23": { winnerTeam: 1, levelDelta: 1 },
    "24": { winnerTeam: 1, levelDelta: 2 },
    "34": { winnerTeam: 1, levelDelta: 3 }
  };
  const mapped = resultMap[placementKey];
  const badge = mapped.winnerTeam === 0 ? `\u4F60\u65B9\u5347 ${mapped.levelDelta} \u7EA7` : `\u5BF9\u65B9\u5347 ${mapped.levelDelta} \u7EA7`;
  const summary = mapped.winnerTeam === 0 ? `\u4F60\u548C\u961F\u53CB\u5206\u5217 ${placementKey[0]}${placementKey[1]}\uFF0C\u4F60\u65B9\u5347 ${mapped.levelDelta} \u7EA7\u3002` : `\u4F60\u548C\u961F\u53CB\u5206\u5217 ${placementKey[0]}${placementKey[1]}\uFF0C\u5BF9\u65B9\u5347 ${mapped.levelDelta} \u7EA7\u3002`;
  return {
    finishOrder: resolvedOrder,
    result: {
      winnerTeam: mapped.winnerTeam,
      levelDelta: mapped.levelDelta,
      placementKey,
      badge,
      summary
    }
  };
}

// src/game/ai.ts
var PLAN_SEARCH_DEPTH = 2;
var PLAN_BRANCH_FACTOR = 5;
var BALANCED_ROLLOUT_PLIES = 5;
var BALANCED_BRANCH_FACTOR = 6;
function chooseAiAction(state, seat, profile = "legacy-v1") {
  switch (profile) {
    case "baseline":
      return chooseBaselineAiAction(state, seat);
    case "legacy-v1":
      return chooseLegacyV1AiAction(state, seat);
    case "balanced-v2":
    default:
      return chooseBalancedV2AiAction(state, seat);
  }
}
function chooseBaselineAiAction(state, seat) {
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = filterLegalPlays(allPlays, state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: "pass" };
  }
  if (!state.tablePlay) {
    return {
      type: "play",
      play: chooseLeadPlay(player.hand.length, legalPlays, player.hand)
    };
  }
  if (sameTeam(seat, state.tablePlay.owner)) {
    const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
    if (finishNow) {
      return { type: "play", play: finishNow };
    }
    return { type: "pass" };
  }
  const ordinaryPlays = legalPlays.filter((play) => !isSpecialPlay(play));
  if (ordinaryPlays.length > 0) {
    return {
      type: "play",
      play: chooseResponsePlay(player.hand.length, ordinaryPlays, player.hand, state)
    };
  }
  const shouldBomb = state.players[state.tablePlay.owner].hand.length <= 5 || player.hand.length <= 6 || state.tablePlay.play.type !== "single";
  if (!shouldBomb) {
    return { type: "pass" };
  }
  return {
    type: "play",
    play: chooseResponsePlay(player.hand.length, legalPlays, player.hand, state)
  };
}
function chooseLegacyV1AiAction(state, seat) {
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = filterLegalPlays(allPlays, state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: "pass" };
  }
  const cache = createPlanningCache();
  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: "play", play: finishNow };
  }
  if (!state.tablePlay) {
    return {
      type: "play",
      play: chooseLegacyLeadPlay(state, seat, legalPlays, cache).play
    };
  }
  if (sameTeam(seat, state.tablePlay.owner)) {
    return { type: "pass" };
  }
  const ordinaryPlays = legalPlays.filter((play) => !isSpecialPlay(play));
  const bestOrdinary = ordinaryPlays.length > 0 ? chooseLegacyResponsePlay(state, seat, ordinaryPlays, cache) : null;
  const bestAny = chooseLegacyResponsePlay(state, seat, legalPlays, cache);
  const passScore = scorePassAction(state, seat, cache);
  if (bestOrdinary && bestOrdinary.score >= passScore) {
    return { type: "play", play: bestOrdinary.play };
  }
  const urgentOpponent = isUrgentOpponentTurn(state, seat);
  const specialMargin = urgentOpponent ? 45 : 95;
  if (bestAny.score >= passScore + (isSpecialPlay(bestAny.play) ? specialMargin : 0)) {
    return { type: "play", play: bestAny.play };
  }
  return { type: "pass" };
}
function chooseBalancedV2AiAction(state, seat) {
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = filterLegalPlays(allPlays, state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: "pass" };
  }
  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: "play", play: finishNow };
  }
  const team = player.team;
  const cache = createPlanningCache();
  const baselineScore = evaluateBalancedState(state, team, cache);
  const candidates = buildBalancedCandidates(state, seat, legalPlays, cache);
  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const score = evaluateBalancedCandidate(state, seat, candidate, team, baselineScore, cache);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (best.type === "pass") {
    return { type: "pass" };
  }
  return {
    type: "play",
    play: best.play
  };
}
function buildBalancedCandidates(state, seat, legalPlays, cache) {
  const candidateMap = /* @__PURE__ */ new Map();
  const scoredPlays = scoreLegacyPlaysForContext(state, seat, legalPlays, cache);
  for (const entry of scoredPlays) {
    if (!shouldConsiderBalancedPlay(state, seat, entry.play)) {
      continue;
    }
    candidateMap.set(entry.play.key, {
      type: "play",
      play: entry.play,
      priorScore: entry.score
    });
    if (candidateMap.size >= BALANCED_BRANCH_FACTOR) {
      break;
    }
  }
  const bestOrdinary = scoredPlays.find((entry) => !isSpecialPlay(entry.play));
  if (bestOrdinary) {
    candidateMap.set(bestOrdinary.play.key, {
      type: "play",
      play: bestOrdinary.play,
      priorScore: bestOrdinary.score
    });
  }
  const bestSpecial = scoredPlays.find((entry) => isSpecialPlay(entry.play));
  if (bestSpecial && shouldConsiderBalancedPlay(state, seat, bestSpecial.play)) {
    candidateMap.set(bestSpecial.play.key, {
      type: "play",
      play: bestSpecial.play,
      priorScore: bestSpecial.score
    });
  }
  const finishNow = legalPlays.find((play) => play.cards.length === state.players[seat].hand.length);
  if (finishNow) {
    candidateMap.set(finishNow.key, {
      type: "play",
      play: finishNow,
      priorScore: 999999
    });
  }
  const candidates = [...candidateMap.values()];
  if (state.tablePlay) {
    candidates.push({
      type: "pass",
      priorScore: scorePassAction(state, seat, cache)
    });
  }
  return candidates;
}
function evaluateBalancedCandidate(state, seat, candidate, team, baselineScore, cache) {
  const player = state.players[seat];
  const nextState = applyCandidateAction(state, seat, candidate);
  let score = evaluateBalancedState(nextState, team, cache) - baselineScore;
  score += candidate.priorScore * 0.45;
  score += rolloutBalancedState(nextState, team, BALANCED_ROLLOUT_PLIES, cache);
  score += scoreBalancedCandidateAdjustment(state, seat, candidate);
  if (candidate.type === "pass") {
    score -= 8;
  } else if (candidate.play && candidate.play.cards.length >= Math.max(5, player.hand.length - 1)) {
    score += 24;
  }
  return score;
}
function shouldConsiderBalancedPlay(state, seat, play) {
  if (!isSpecialPlay(play)) {
    return true;
  }
  const player = state.players[seat];
  if (play.cards.length === player.hand.length) {
    return true;
  }
  if (!state.tablePlay) {
    return player.hand.length <= 8;
  }
  const owner = state.players[state.tablePlay.owner];
  if (isSpecialPlay(state.tablePlay.play)) {
    return true;
  }
  if (!sameTeam(seat, owner.seat) && owner.hand.length <= 3) {
    return true;
  }
  return player.hand.length <= 6;
}
function scoreBalancedCandidateAdjustment(state, seat, candidate) {
  if (candidate.type === "pass") {
    if (!state.tablePlay) {
      return -999999;
    }
    const owner = state.players[state.tablePlay.owner];
    if (!sameTeam(seat, owner.seat) && owner.hand.length <= 3) {
      return -120;
    }
    return 0;
  }
  const player = state.players[seat];
  const play = candidate.play;
  let score = 0;
  if (!state.tablePlay) {
    if (isSpecialPlay(play) && play.cards.length !== player.hand.length) {
      score -= 220 + (play.bombSize ?? 0) * 24;
    }
    if ((play.type === "single" || play.type === "pair") && play.primaryValue >= 14 && player.hand.length >= 8) {
      score -= 75 + (play.primaryValue - 14) * 18;
    }
  } else {
    const target = state.tablePlay.play;
    const owner = state.players[state.tablePlay.owner];
    const urgentOpponent = !sameTeam(seat, owner.seat) && owner.hand.length <= 3;
    if (play.type === target.type && !isSpecialPlay(play)) {
      const overtake = play.primaryValue - target.primaryValue - 1;
      if (overtake > 0) {
        score -= overtake * (play.type === "single" ? 28 : play.type === "pair" ? 18 : 12);
      }
    }
    if (isSpecialPlay(play) && !urgentOpponent && !isSpecialPlay(target) && player.hand.length > 6) {
      score -= 180 + (play.bombSize ?? 0) * 26;
    }
    if (play.type === "single" && play.primaryValue >= 15 && !urgentOpponent && player.hand.length >= 5) {
      score -= 90;
    }
  }
  if (play.wildCount > 0 && player.hand.length >= 7) {
    score -= play.wildCount * 22;
  }
  return score;
}
function scoreLegacyPlaysForContext(state, seat, plays, cache) {
  if (!state.tablePlay) {
    return scoreLegacyPlays(plays, (play) => scoreLegacyLeadPlay(state, seat, play, cache));
  }
  return scoreLegacyPlays(plays, (play) => scoreLegacyResponsePlay(state, seat, play, cache));
}
function scoreLegacyPlays(plays, scorePlay) {
  return plays.map((play) => ({
    play,
    score: scorePlay(play)
  })).sort((left, right) => right.score - left.score);
}
function chooseLeadPlay(handSize, plays, hand) {
  return [...plays].sort((left, right) => scoreLeadPlay(right, handSize, hand) - scoreLeadPlay(left, handSize, hand))[0];
}
function chooseResponsePlay(handSize, plays, hand, state) {
  return [...plays].sort((left, right) => scoreResponsePlay(right, handSize, hand, state) - scoreResponsePlay(left, handSize, hand, state))[0];
}
function chooseLegacyLeadPlay(state, seat, plays, cache) {
  return scoreLegacyPlays(plays, (play) => scoreLegacyLeadPlay(state, seat, play, cache))[0];
}
function chooseLegacyResponsePlay(state, seat, plays, cache) {
  return scoreLegacyPlays(plays, (play) => scoreLegacyResponsePlay(state, seat, play, cache))[0];
}
function scoreLegacyLeadPlay(state, seat, play, cache) {
  const hand = state.players[seat].hand;
  const nextHand = removePlayFromHand(hand, play);
  const nextSeat = getNextActiveSeat(state.players, seat);
  const nextPlayer = state.players[nextSeat];
  let score = evaluateHandPlan(nextHand, cache);
  score += play.cards.length * 30;
  score += legacyLeadTypeBonus(play);
  score -= getLeadRankPressure(play);
  score -= play.wildCount * 28;
  if (play.cards.length === hand.length) {
    score += 12e4;
  }
  if (isSpecialPlay(play)) {
    score -= 165 + (play.bombSize ?? 0) * 16;
    if (!sameTeam(seat, nextSeat) && nextPlayer.hand.length <= 3) {
      score += 110;
    }
  }
  if (usesRankPotentialBomb(hand, play)) {
    score -= 65;
  }
  if (!sameTeam(seat, nextSeat) && nextPlayer.hand.length <= 2) {
    score += 65 + play.cards.length * 6;
  }
  return score;
}
function scoreLegacyResponsePlay(state, seat, play, cache) {
  const player = state.players[seat];
  const target = state.tablePlay.play;
  const owner = state.players[state.tablePlay.owner];
  const nextSeat = getNextActiveSeat(state.players, seat);
  const nextPlayer = state.players[nextSeat];
  const nextHand = removePlayFromHand(player.hand, play);
  let score = evaluateHandPlan(nextHand, cache);
  score += play.cards.length * 18;
  score -= play.wildCount * 32;
  if (play.cards.length === player.hand.length) {
    score += 12e4;
  }
  if (play.type === target.type && !isSpecialPlay(play)) {
    score += 80;
    score -= (play.primaryValue - target.primaryValue) * 11;
  }
  if (!isSpecialPlay(play)) {
    score += 55;
  } else {
    score -= 150 + (play.bombSize ?? 0) * 20;
    if (owner.hand.length <= 2 || nextPlayer.hand.length <= 2 || player.hand.length <= 6) {
      score += 130;
    }
    if (target.type === "bomb" || target.type === "straight-flush" || target.type === "joker-bomb") {
      score += 40;
    }
  }
  if (usesRankPotentialBomb(player.hand, play)) {
    score -= 70;
  }
  if (owner.hand.length <= 3) {
    score += 150;
  }
  if (owner.hand.length === 1) {
    score += 90;
  }
  if (sameTeam(seat, nextSeat)) {
    score += 60;
  } else if (nextPlayer.hand.length <= 2) {
    score += 80;
  }
  return score;
}
function scorePassAction(state, seat, cache) {
  const player = state.players[seat];
  const owner = state.players[state.tablePlay.owner];
  const nextSeat = getNextActiveSeat(state.players, seat);
  let score = evaluateHandPlan(player.hand, cache) - 35;
  if (owner.hand.length <= 3) {
    score -= 230;
  }
  if (owner.hand.length === 1) {
    score -= 110;
  }
  if (sameTeam(seat, nextSeat)) {
    score += 55;
  } else {
    score -= 25;
  }
  if (state.tablePlay.play.type === "single" && state.tablePlay.play.primaryValue >= 14) {
    score += 30;
  }
  return score;
}
function evaluateBalancedState(state, rootTeam, cache) {
  if (state.result) {
    const outcome = state.result.winnerTeam === rootTeam ? 1 : -1;
    return outcome * (3e5 + state.result.levelDelta * 6e4);
  }
  let score = 0;
  let teamCards = 0;
  let opponentCards = 0;
  for (const player of state.players) {
    const factor = player.team === rootTeam ? 1 : -1;
    const planScore = evaluateHandPlan(player.hand, cache);
    score += factor * planScore * 1.15;
    if (player.team === rootTeam) {
      teamCards += player.hand.length;
    } else {
      opponentCards += player.hand.length;
    }
    if (player.finished) {
      const finishIndex = state.finishOrder.indexOf(player.seat);
      score += factor * (52e3 - Math.max(0, finishIndex) * 7500);
    } else {
      score -= factor * player.hand.length * 120;
    }
  }
  score += (opponentCards - teamCards) * 58;
  if (state.tablePlay) {
    score += sameTeam(state.tablePlay.owner, rootTeam === 0 ? 0 : 1) ? 95 : -95;
    score += sameTeam(state.tablePlay.owner, rootTeam === 0 ? 0 : 1) ? Math.max(0, 8 - state.players[state.tablePlay.owner].hand.length) * 14 : -Math.max(0, 8 - state.players[state.tablePlay.owner].hand.length) * 18;
  }
  const currentFactor = state.players[state.currentPlayer].team === rootTeam ? 1 : -1;
  score += currentFactor * 24;
  return score;
}
function rolloutBalancedState(state, rootTeam, pliesRemaining, cache) {
  if (pliesRemaining <= 0 || state.result) {
    return evaluateBalancedState(state, rootTeam, cache);
  }
  const seat = state.currentPlayer;
  const decision = chooseLegacyV1AiAction(state, seat);
  const nextState = decision.type === "play" && decision.play ? applyPlay(state, seat, decision.play) : applyPass(state, seat);
  return evaluateBalancedState(nextState, rootTeam, cache) * 0.42 + rolloutBalancedState(nextState, rootTeam, pliesRemaining - 1, cache) * 0.58;
}
function applyCandidateAction(state, seat, candidate) {
  if (candidate.type === "pass") {
    return applyPass(state, seat);
  }
  return applyPlay(state, seat, candidate.play);
}
function createPlanningCache() {
  return {
    handScore: /* @__PURE__ */ new Map(),
    minTurns: /* @__PURE__ */ new Map(),
    greedyStats: /* @__PURE__ */ new Map()
  };
}
function evaluateHandPlan(hand, cache) {
  const key = handStateKey(hand);
  const cached = cache.handScore.get(key);
  if (cached !== void 0) {
    return cached;
  }
  if (hand.length === 0) {
    cache.handScore.set(key, 8e3);
    return 8e3;
  }
  const exactOut = generateAllPlays(hand).find((play) => play.cards.length === hand.length);
  if (exactOut) {
    const exactScore = 2600 + hand.length * 24;
    cache.handScore.set(key, exactScore);
    return exactScore;
  }
  const turns = estimateMinTurns(hand, PLAN_SEARCH_DEPTH, cache);
  const stats = buildGreedyPlanStats(hand, cache);
  const wildCount = hand.filter((card) => card.isWild).length;
  const score = -turns * 235 - stats.singles * 26 - stats.wildSingles * 14 + stats.pairs * 10 + stats.triples * 16 + stats.fullHouses * 22 + stats.straights * 20 + stats.pairRuns * 28 + stats.tripleRuns * 34 + stats.bombs * 22 + stats.straightFlushes * 26 + stats.jokerBombs * 30 + wildCount * 10 - hand.length * 3;
  cache.handScore.set(key, score);
  return score;
}
function estimateMinTurns(hand, depth, cache) {
  if (hand.length === 0) {
    return 0;
  }
  const key = `${depth}:${handStateKey(hand)}`;
  const cached = cache.minTurns.get(key);
  if (cached !== void 0) {
    return cached;
  }
  const plays = generateAllPlays(hand);
  if (plays.some((play) => play.cards.length === hand.length)) {
    cache.minTurns.set(key, 1);
    return 1;
  }
  if (depth <= 0) {
    const greedyTurns = buildGreedyPlanStats(hand, cache).turns;
    cache.minTurns.set(key, greedyTurns);
    return greedyTurns;
  }
  const candidates = rankPlanCandidates(plays, hand).slice(0, PLAN_BRANCH_FACTOR);
  let bestTurns = Number.POSITIVE_INFINITY;
  for (const play of candidates) {
    const turns = 1 + estimateMinTurns(removePlayFromHand(hand, play), depth - 1, cache);
    if (turns < bestTurns) {
      bestTurns = turns;
    }
  }
  cache.minTurns.set(key, bestTurns);
  return bestTurns;
}
function buildGreedyPlanStats(hand, cache) {
  const key = handStateKey(hand);
  const cached = cache.greedyStats.get(key);
  if (cached) {
    return cached;
  }
  const stats = {
    turns: 0,
    singles: 0,
    pairs: 0,
    triples: 0,
    fullHouses: 0,
    straights: 0,
    pairRuns: 0,
    tripleRuns: 0,
    bombs: 0,
    straightFlushes: 0,
    jokerBombs: 0,
    wildSingles: 0
  };
  let remaining = [...hand];
  while (remaining.length > 0) {
    const plays = generateAllPlays(remaining);
    const nextPlay = rankPlanCandidates(plays, remaining)[0];
    stats.turns += 1;
    switch (nextPlay.type) {
      case "single":
        stats.singles += 1;
        if (nextPlay.cards.some((card) => card.isWild)) {
          stats.wildSingles += 1;
        }
        break;
      case "pair":
        stats.pairs += 1;
        break;
      case "triple":
        stats.triples += 1;
        break;
      case "full-house":
        stats.fullHouses += 1;
        break;
      case "straight":
        stats.straights += 1;
        break;
      case "pair-run":
        stats.pairRuns += 1;
        break;
      case "triple-run":
        stats.tripleRuns += 1;
        break;
      case "bomb":
        stats.bombs += 1;
        break;
      case "straight-flush":
        stats.straightFlushes += 1;
        break;
      case "joker-bomb":
        stats.jokerBombs += 1;
        break;
      default:
        break;
    }
    remaining = removePlayFromHand(remaining, nextPlay);
  }
  cache.greedyStats.set(key, stats);
  return stats;
}
function rankPlanCandidates(plays, hand) {
  return [...plays].sort((left, right) => scorePlanCandidate(right, hand) - scorePlanCandidate(left, hand));
}
function scorePlanCandidate(play, hand) {
  let score = play.cards.length * 90 + planTypeBonus(play);
  score -= play.wildCount * 24;
  if (play.cards.length === hand.length) {
    score += 1e5;
  }
  if (play.type === "single") {
    score -= 90;
    score -= play.primaryValue * 3;
  }
  if (play.type === "pair") {
    score -= 30;
    score -= play.primaryValue * 2;
  }
  if (isSpecialPlay(play)) {
    score -= 85;
  }
  if (usesRankPotentialBomb(hand, play)) {
    score -= 55;
  }
  return score;
}
function removePlayFromHand(hand, play) {
  const playedIds = new Set(play.cards.map((card) => card.id));
  return hand.filter((card) => !playedIds.has(card.id));
}
function handStateKey(hand) {
  return hand.map((card) => card.id).sort().join("|");
}
function isUrgentOpponentTurn(state, seat) {
  const owner = state.players[state.tablePlay.owner];
  if (!sameTeam(seat, owner.seat) && owner.hand.length <= 3) {
    return true;
  }
  return state.players.some((player) => !sameTeam(seat, player.seat) && !player.finished && player.hand.length <= 2);
}
function scoreLeadPlay(play, handSize, hand) {
  let score = play.cards.length * 18;
  score += typeLeadBonus(play);
  score -= play.primaryValue;
  score -= play.wildCount * 10;
  if (play.cards.length === handSize) {
    score += 2e3;
  }
  if (isSpecialPlay(play)) {
    score -= 120;
  }
  if (usesRankPotentialBomb(hand, play)) {
    score -= 40;
  }
  if (handSize <= 8 && play.cards.length >= handSize - 1) {
    score += 20;
  }
  return score;
}
function scoreResponsePlay(play, handSize, hand, state) {
  let score = 200;
  score -= play.primaryValue * 2;
  score -= play.wildCount * 12;
  if (play.cards.length === handSize) {
    score += 2e3;
  }
  if (!isSpecialPlay(play)) {
    score += 80;
  } else if (state.players[state.tablePlay.owner].hand.length <= 3) {
    score += 30;
  } else {
    score -= 60;
  }
  if (usesRankPotentialBomb(hand, play)) {
    score -= 45;
  }
  score -= (play.bombSize ?? 0) * 6;
  return score;
}
function typeLeadBonus(play) {
  switch (play.type) {
    case "single":
      return 0;
    case "pair":
      return 4;
    case "triple":
      return 8;
    case "full-house":
      return 16;
    case "straight":
      return 15;
    case "pair-run":
      return 18;
    case "triple-run":
      return 20;
    case "bomb":
      return 6;
    case "straight-flush":
      return 10;
    case "joker-bomb":
      return 12;
    default:
      return 0;
  }
}
function legacyLeadTypeBonus(play) {
  switch (play.type) {
    case "single":
      return -15;
    case "pair":
      return -2;
    case "triple":
      return 16;
    case "full-house":
      return 36;
    case "straight":
      return 30;
    case "pair-run":
      return 40;
    case "triple-run":
      return 48;
    case "bomb":
      return 12;
    case "straight-flush":
      return 18;
    case "joker-bomb":
      return 20;
    default:
      return 0;
  }
}
function planTypeBonus(play) {
  switch (play.type) {
    case "single":
      return 0;
    case "pair":
      return 18;
    case "triple":
      return 28;
    case "full-house":
      return 52;
    case "straight":
      return 48;
    case "pair-run":
      return 66;
    case "triple-run":
      return 82;
    case "bomb":
      return 34;
    case "straight-flush":
      return 38;
    case "joker-bomb":
      return 42;
    default:
      return 0;
  }
}
function getLeadRankPressure(play) {
  if (play.type === "single" || play.type === "pair") {
    return play.primaryValue * 5;
  }
  if (play.type === "triple") {
    return play.primaryValue * 2;
  }
  return play.primaryValue;
}

// src/arena/prompt.ts
var ARENA_LLM_SYSTEM_PROMPT = [
  "You are playing Guandan in a code-driven arena as a cooperative teammate.",
  "Optimize for your team result over the whole game, not just the current trick.",
  "Your objective is to maximize your team expected level delta, not merely to win the current trick or blindly chase any win.",
  "The final game result is determined by the go-out sequence of both teams.",
  "A stronger finishing order for your team means more levels gained; a weaker finishing order means a larger level loss.",
  "Once one player goes out, the game may still continue because later finish positions still affect the final level outcome.",
  "Choose exactly one legal action and return JSON only."
].join(" ");

// src/arena/engine.ts
var ARENA_RULES_SUMMARY = {
  trumpRank: "A",
  wildCard: "hearts-A",
  notes: [
    "Two decks with two jokers per deck.",
    "Seats 0 and 2 are partners. Seats 1 and 3 are partners.",
    "Only hearts A is wild. Other A cards are normal A.",
    "Straights allow 10-J-Q-K-A, A-2-3-4-5, and 2-3-4-5-6. Jokers cannot be inside straights.",
    "Pair runs allow A-A-2-2-3-3. Triple runs allow A-A-A-2-2-2.",
    "Straight flush beats 5-bomb and 4-bomb, but loses to 6-bomb and above.",
    "Bomb order: 4 jokers > 8-bomb > 7-bomb > 6-bomb > straight flush > 5-bomb > 4-bomb > ordinary plays."
  ],
  finishOutcomes: [
    { placement: "12", winnerTeam: 0, levelDelta: 3 },
    { placement: "13", winnerTeam: 0, levelDelta: 2 },
    { placement: "14", winnerTeam: 0, levelDelta: 1 },
    { placement: "23", winnerTeam: 1, levelDelta: 1 },
    { placement: "24", winnerTeam: 1, levelDelta: 2 },
    { placement: "34", winnerTeam: 1, levelDelta: 3 }
  ]
};
function createHeuristicAgent(config) {
  return {
    id: config?.id ?? "builtin-heuristic",
    label: config?.label ?? (config?.profile === "baseline" ? "Builtin Baseline" : config?.profile === "legacy-v1" ? "guandan-ai v1" : "guandan-ai v2 balanced"),
    decideTurn(input, context) {
      const decision = chooseAiAction(context.state, context.seat, config?.profile ?? "legacy-v1");
      if (decision.type === "pass" || !decision.play) {
        return { kind: "pass" };
      }
      return {
        kind: "play",
        actionId: actionIdForPlay(decision.play)
      };
    }
  };
}
var GuandanArenaMatch = class {
  state;
  agents;
  constructor(config) {
    this.state = config.initialState ?? createNewGame();
    this.agents = normalizeSeatRoster(config.agents);
  }
  getState() {
    return this.state;
  }
  reset(nextState) {
    this.state = nextState ?? createNewGame();
    return this.state;
  }
  setSeatAgent(seat, agent) {
    this.agents[seat] = agent;
  }
  getTurnInput(seat = this.state.currentPlayer) {
    return buildArenaTurnInput(this.state, seat);
  }
  stepWithAction(action, seat = this.state.currentPlayer) {
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
      nextState: this.state
    };
  }
  async step() {
    if (this.state.result) {
      throw new Error(`Match already finished: ${this.state.result.summary}`);
    }
    const seat = this.state.currentPlayer;
    const agent = this.agents[seat];
    const input = buildArenaTurnInput(this.state, seat);
    const chosenAction = await agent.decideTurn(input, {
      seat,
      state: this.state
    });
    this.state = applyArenaChosenAction(this.state, seat, chosenAction);
    return {
      seat,
      input,
      action: chosenAction,
      nextState: this.state
    };
  }
  async runUntilFinished(options) {
    const maxTurns = options?.maxTurns ?? 500;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (this.state.result) {
        return this.state;
      }
      await this.step();
    }
    throw new Error(`Match exceeded ${maxTurns} turns without a terminal result.`);
  }
};
function buildArenaTurnInput(state, seat) {
  return {
    knowledgeMode: "public_history",
    seat,
    currentPlayer: state.currentPlayer,
    players: buildArenaPlayers(state),
    hand: state.players[seat].hand.map(serializeCard),
    currentTablePlay: state.tablePlay ? {
      owner: state.tablePlay.owner,
      play: serializePlay(state.tablePlay.play)
    } : null,
    roundTrace: buildRoundTrace(state),
    finishOrder: [...state.finishOrder],
    message: state.message,
    result: state.result,
    legalActions: getLegalActionsForSeat(state, seat),
    rules: ARENA_RULES_SUMMARY,
    publicKnowledge: buildPublicKnowledge(state)
  };
}
function getLegalActionsForSeat(state, seat) {
  if (state.result || state.currentPlayer !== seat) {
    return [];
  }
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = sortPlayOptionsForContext(
    filterLegalPlays(allPlays, state.tablePlay?.play ?? null),
    state.tablePlay?.play ?? null
  );
  const playActions = legalPlays.map((play) => toActionOption(play));
  if (!state.tablePlay) {
    return playActions;
  }
  return [
    ...playActions,
    {
      actionId: "pass",
      kind: "pass",
      label: "\u4E0D\u51FA",
      cardIds: [],
      play: null
    }
  ];
}
function applyArenaChosenAction(state, seat, action) {
  if (state.result) {
    throw new Error(`Match already finished: ${state.result.summary}`);
  }
  if (state.currentPlayer !== seat) {
    throw new Error(`Seat ${seat} cannot act now. Current player is seat ${state.currentPlayer}.`);
  }
  const legalActions = getLegalActionsForSeat(state, seat);
  if (action.kind === "pass") {
    if (!legalActions.some((item) => item.kind === "pass")) {
      throw new Error("Pass is not a legal action right now.");
    }
    return applyPass(state, seat);
  }
  const matchedAction = legalActions.find((item) => item.actionId === action.actionId);
  if (!matchedAction || !matchedAction.play) {
    const legalIds = legalActions.map((item) => item.actionId).join(", ");
    throw new Error(`Unknown or illegal actionId "${action.actionId}". Legal actions: ${legalIds}`);
  }
  const matchedPlay = generateConcreteLegalPlays(state.players[seat].hand, state.tablePlay?.play ?? null).find(
    (play) => actionIdForPlay(play) === action.actionId
  );
  if (!matchedPlay) {
    throw new Error(`Unable to resolve concrete play for actionId "${action.actionId}".`);
  }
  return applyPlay(state, seat, matchedPlay);
}
function validateArenaChosenAction(action, legalActions) {
  if (action.kind !== "pass" && action.kind !== "play") {
    throw new Error('Chosen action must use kind "pass" or "play".');
  }
  if (action.kind === "play") {
    if (!action.actionId) {
      throw new Error("Play actions must include actionId.");
    }
    if (legalActions && !legalActions.some((item) => item.kind === "play" && item.actionId === action.actionId)) {
      const legalIds = legalActions.filter((item) => item.kind === "play").map((item) => item.actionId).join(", ");
      throw new Error(`Illegal play actionId "${action.actionId}". Legal play ids: ${legalIds}`);
    }
    return action;
  }
  if (legalActions && !legalActions.some((item) => item.kind === "pass")) {
    throw new Error("Pass was returned, but pass is not legal in this position.");
  }
  return action;
}
function generateConcreteLegalPlays(hand, target) {
  return sortPlayOptionsForContext(filterLegalPlays(generateAllPlays(hand), target), target);
}
function toActionOption(play) {
  return {
    actionId: actionIdForPlay(play),
    kind: "play",
    label: play.label,
    cardIds: play.cards.map((card) => card.id),
    play: serializePlay(play)
  };
}
function buildArenaPlayers(state) {
  return state.players.map((player) => ({
    seat: player.seat,
    team: player.team,
    name: player.name,
    handCount: player.hand.length,
    finished: player.finished,
    finishPosition: state.finishOrder.indexOf(player.seat) === -1 ? null : state.finishOrder.indexOf(player.seat) + 1,
    lastAction: state.lastActions[player.seat],
    currentRoundAction: state.roundTrace[player.seat].action
  }));
}
function buildRoundTrace(state) {
  return {
    0: {
      action: state.roundTrace[0].action,
      play: state.roundTrace[0].play ? serializePlay(state.roundTrace[0].play) : null
    },
    1: {
      action: state.roundTrace[1].action,
      play: state.roundTrace[1].play ? serializePlay(state.roundTrace[1].play) : null
    },
    2: {
      action: state.roundTrace[2].action,
      play: state.roundTrace[2].play ? serializePlay(state.roundTrace[2].play) : null
    },
    3: {
      action: state.roundTrace[3].action,
      play: state.roundTrace[3].play ? serializePlay(state.roundTrace[3].play) : null
    }
  };
}
function buildPublicKnowledge(state) {
  const actionHistory = state.actionHistory.map(serializeActionHistoryEntry);
  const seenCards = state.actionHistory.flatMap((entry) => entry.play ? entry.play.cards.map(serializeCard) : []);
  const remainingHandCounts = {
    0: state.players[0].hand.length,
    1: state.players[1].hand.length,
    2: state.players[2].hand.length,
    3: state.players[3].hand.length
  };
  return {
    actionHistory,
    seenCards,
    remainingHandCounts
  };
}
function serializeCard(card) {
  return {
    id: card.id,
    suit: card.suit,
    rank: card.rank,
    deck: card.deck,
    isWild: card.isWild
  };
}
function serializePlay(play) {
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
    cards: play.cards.map(serializeCard)
  };
}
function serializeActionHistoryEntry(entry) {
  return {
    turn: entry.turn,
    seat: entry.seat,
    action: entry.action,
    play: entry.play ? serializePlay(entry.play) : null,
    handCountAfter: entry.handCountAfter,
    tableOwnerAfter: entry.tableOwnerAfter,
    tablePlayAfter: entry.tablePlayAfter ? serializePlay(entry.tablePlayAfter) : null
  };
}
function normalizeSeatRoster(roster) {
  if (Array.isArray(roster)) {
    return {
      0: roster[0],
      1: roster[1],
      2: roster[2],
      3: roster[3]
    };
  }
  return roster;
}
function actionIdForPlay(play) {
  return `play:${play.key}`;
}

// tools/runLegacyMirror.ts
async function main() {
  const seed = Number(process.argv[2] ?? "20260413");
  const match = new GuandanArenaMatch({
    initialState: createNewGame(createSeededRandom(seed)),
    agents: [
      createHeuristicAgent({ profile: "legacy-v1", label: "Legacy 0" }),
      createHeuristicAgent({ profile: "legacy-v1", label: "Legacy 1" }),
      createHeuristicAgent({ profile: "legacy-v1", label: "Legacy 2" }),
      createHeuristicAgent({ profile: "legacy-v1", label: "Legacy 3" })
    ]
  });
  const state = await match.runUntilFinished({ maxTurns: 500 });
  console.log(
    JSON.stringify(
      {
        seed,
        result: state.result,
        finishOrder: state.finishOrder,
        turns: state.actionHistory.length
      },
      null,
      2
    )
  );
}
void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exitCode = 1;
});

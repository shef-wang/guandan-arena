import { filterLegalPlays, generateAllPlays, isSpecialPlay, sameTeam, usesRankPotentialBomb } from './rules';
import { applyPass, applyPlay, getNextActiveSeat } from './state';
import type { AiDecision, Card, GameState, Play, Seat, Team } from './types';

export type AiProfile = 'baseline' | 'legacy-v1' | 'legacy-vR' | 'balanced-v2';

interface ScoredPlay {
  play: Play;
  score: number;
}

export interface RankedAiActionCandidate {
  type: 'play' | 'pass';
  play?: Play;
  score: number;
}

interface PlanningCache {
  handScore: Map<string, number>;
  minTurns: Map<string, number>;
  greedyStats: Map<string, PlanStats>;
}

interface PlanStats {
  turns: number;
  singles: number;
  pairs: number;
  triples: number;
  fullHouses: number;
  straights: number;
  pairRuns: number;
  tripleRuns: number;
  bombs: number;
  straightFlushes: number;
  jokerBombs: number;
  wildSingles: number;
}

interface CandidateAction {
  type: 'pass' | 'play';
  play?: Play;
  priorScore: number;
}

const PLAN_SEARCH_DEPTH = 2;
const PLAN_BRANCH_FACTOR = 5;
const BALANCED_ROLLOUT_PLIES = 5;
const BALANCED_BRANCH_FACTOR = 6;
const LEGACY_VR_TOP_K = 3;
const LEGACY_VR_RANK_WEIGHTS = [3, 2, 1] as const;

export function chooseAiAction(state: GameState, seat: Seat, profile: AiProfile = 'legacy-v1'): AiDecision {
  switch (profile) {
    case 'baseline':
      return chooseBaselineAiAction(state, seat);
    case 'legacy-v1':
      return chooseLegacyV1AiAction(state, seat);
    case 'legacy-vR':
      return chooseLegacyVRAiAction(state, seat);
    case 'balanced-v2':
    default:
      return chooseBalancedV2AiAction(state, seat);
  }
}

export function chooseBaselineAiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = filterLegalPlays(allPlays, state.tablePlay?.play ?? null);

  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  if (!state.tablePlay) {
    return {
      type: 'play',
      play: chooseLeadPlay(player.hand.length, legalPlays, player.hand),
    };
  }

  if (sameTeam(seat, state.tablePlay.owner)) {
    const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
    if (finishNow) {
      return { type: 'play', play: finishNow };
    }

    return { type: 'pass' };
  }

  const ordinaryPlays = legalPlays.filter((play) => !isSpecialPlay(play));
  if (ordinaryPlays.length > 0) {
    return {
      type: 'play',
      play: chooseResponsePlay(player.hand.length, ordinaryPlays, player.hand, state),
    };
  }

  const shouldBomb =
    state.players[state.tablePlay.owner].hand.length <= 5 ||
    player.hand.length <= 6 ||
    state.tablePlay.play.type !== 'single';

  if (!shouldBomb) {
    return { type: 'pass' };
  }

  return {
    type: 'play',
    play: chooseResponsePlay(player.hand.length, legalPlays, player.hand, state),
  };
}

export function chooseLegacyV1AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = filterLegalPlays(allPlays, state.tablePlay?.play ?? null);

  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const cache = createPlanningCache();
  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  if (!state.tablePlay) {
    return {
      type: 'play',
      play: chooseLegacyLeadPlay(state, seat, legalPlays, cache).play,
    };
  }

  if (sameTeam(seat, state.tablePlay.owner)) {
    return { type: 'pass' };
  }

  const ordinaryPlays = legalPlays.filter((play) => !isSpecialPlay(play));
  const bestOrdinary = ordinaryPlays.length > 0 ? chooseLegacyResponsePlay(state, seat, ordinaryPlays, cache) : null;
  const bestAny = chooseLegacyResponsePlay(state, seat, legalPlays, cache);
  const passScore = scorePassAction(state, seat, cache);

  if (bestOrdinary && bestOrdinary.score >= passScore) {
    return { type: 'play', play: bestOrdinary.play };
  }

  const urgentOpponent = isUrgentOpponentTurn(state, seat);
  const specialMargin = urgentOpponent ? 45 : 95;
  if (bestAny.score >= passScore + (isSpecialPlay(bestAny.play) ? specialMargin : 0)) {
    return { type: 'play', play: bestAny.play };
  }

  return { type: 'pass' };
}

export function chooseLegacyVRAiAction(state: GameState, seat: Seat): AiDecision {
  const candidates = rankLegacyV1ActionCandidates(state, seat).slice(0, LEGACY_VR_TOP_K);
  if (candidates.length === 0) {
    return { type: 'pass' };
  }

  const totalWeight = candidates.reduce((sum, _candidate, index) => sum + (LEGACY_VR_RANK_WEIGHTS[index] ?? 1), 0);
  let remaining = deterministicLegacyVRRoll(state, seat) * totalWeight;

  for (let index = 0; index < candidates.length; index += 1) {
    remaining -= LEGACY_VR_RANK_WEIGHTS[index] ?? 1;
    if (remaining <= 0) {
      return toAiDecision(candidates[index]);
    }
  }

  return toAiDecision(candidates[candidates.length - 1]);
}

export function rankLegacyV1ActionCandidates(state: GameState, seat: Seat): RankedAiActionCandidate[] {
  if (state.result || state.currentPlayer !== seat) {
    return [];
  }

  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  const cache = createPlanningCache();

  if (!state.tablePlay) {
    return legalPlays
      .map((play) => ({
        type: 'play' as const,
        play,
        score: scoreLegacyLeadPlay(state, seat, play, cache),
      }))
      .sort((left, right) => right.score - left.score);
  }

  if (sameTeam(seat, state.tablePlay.owner)) {
    const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
    const candidates: RankedAiActionCandidate[] = [
      {
        type: 'pass',
        score: finishNow ? 119_000 : 120_000,
      },
    ];

    if (finishNow) {
      candidates.push({
        type: 'play',
        play: finishNow,
        score: 120_000,
      });
    }

    return candidates;
  }

  const candidates: RankedAiActionCandidate[] = legalPlays.map((play) => ({
    type: 'play',
    play,
    score: scoreLegacyResponsePlay(state, seat, play, cache),
  }));

  candidates.push({
    type: 'pass',
    score: legalPlays.length === 0 ? 999_999 : scorePassAction(state, seat, cache),
  });

  return candidates.sort((left, right) => right.score - left.score);
}

export function chooseBalancedV2AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const allPlays = generateAllPlays(player.hand);
  const legalPlays = filterLegalPlays(allPlays, state.tablePlay?.play ?? null);

  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
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

  if (best.type === 'pass') {
    return { type: 'pass' };
  }

  return {
    type: 'play',
    play: best.play,
  };
}

function toAiDecision(candidate: RankedAiActionCandidate): AiDecision {
  if (candidate.type === 'play' && candidate.play) {
    return {
      type: 'play',
      play: candidate.play,
    };
  }

  return { type: 'pass' };
}

function deterministicLegacyVRRoll(state: GameState, seat: Seat): number {
  const snapshot = [
    `seat=${seat}`,
    `turn=${state.actionHistory.length}`,
    `current=${state.currentPlayer}`,
    `table=${state.tablePlay?.play.key ?? 'lead'}`,
    `finish=${state.finishOrder.join(',')}`,
    `hand=${state.players[seat].hand.map((card) => card.id).join(',')}`,
  ].join('|');

  let hash = 2166136261;
  for (let index = 0; index < snapshot.length; index += 1) {
    hash ^= snapshot.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967296;
}

function buildBalancedCandidates(state: GameState, seat: Seat, legalPlays: Play[], cache: PlanningCache): CandidateAction[] {
  const candidateMap = new Map<string, CandidateAction>();
  const scoredPlays = scoreLegacyPlaysForContext(state, seat, legalPlays, cache);

  for (const entry of scoredPlays) {
    if (!shouldConsiderBalancedPlay(state, seat, entry.play)) {
      continue;
    }

    candidateMap.set(entry.play.key, {
      type: 'play',
      play: entry.play,
      priorScore: entry.score,
    });

    if (candidateMap.size >= BALANCED_BRANCH_FACTOR) {
      break;
    }
  }

  const bestOrdinary = scoredPlays.find((entry) => !isSpecialPlay(entry.play));
  if (bestOrdinary) {
    candidateMap.set(bestOrdinary.play.key, {
      type: 'play',
      play: bestOrdinary.play,
      priorScore: bestOrdinary.score,
    });
  }

  const bestSpecial = scoredPlays.find((entry) => isSpecialPlay(entry.play));
  if (bestSpecial && shouldConsiderBalancedPlay(state, seat, bestSpecial.play)) {
    candidateMap.set(bestSpecial.play.key, {
      type: 'play',
      play: bestSpecial.play,
      priorScore: bestSpecial.score,
    });
  }

  const finishNow = legalPlays.find((play) => play.cards.length === state.players[seat].hand.length);
  if (finishNow) {
    candidateMap.set(finishNow.key, {
      type: 'play',
      play: finishNow,
      priorScore: 999_999,
    });
  }

  const candidates = [...candidateMap.values()];

  if (state.tablePlay) {
    candidates.push({
      type: 'pass',
      priorScore: scorePassAction(state, seat, cache),
    });
  }

  return candidates;
}

function evaluateBalancedCandidate(
  state: GameState,
  seat: Seat,
  candidate: CandidateAction,
  team: Team,
  baselineScore: number,
  cache: PlanningCache,
): number {
  const player = state.players[seat];
  const nextState = applyCandidateAction(state, seat, candidate);
  let score = evaluateBalancedState(nextState, team, cache) - baselineScore;
  score += candidate.priorScore * 0.45;
  score += rolloutBalancedState(nextState, team, BALANCED_ROLLOUT_PLIES, cache);
  score += scoreBalancedCandidateAdjustment(state, seat, candidate);

  if (candidate.type === 'pass') {
    score -= 8;
  } else if (candidate.play && candidate.play.cards.length >= Math.max(5, player.hand.length - 1)) {
    score += 24;
  }

  return score;
}

function shouldConsiderBalancedPlay(state: GameState, seat: Seat, play: Play): boolean {
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

function scoreBalancedCandidateAdjustment(state: GameState, seat: Seat, candidate: CandidateAction): number {
  if (candidate.type === 'pass') {
    if (!state.tablePlay) {
      return -999_999;
    }

    const owner = state.players[state.tablePlay.owner];
    if (!sameTeam(seat, owner.seat) && owner.hand.length <= 3) {
      return -120;
    }

    return 0;
  }

  const player = state.players[seat];
  const play = candidate.play!;
  let score = 0;

  if (!state.tablePlay) {
    if (isSpecialPlay(play) && play.cards.length !== player.hand.length) {
      score -= 220 + (play.bombSize ?? 0) * 24;
    }

    if ((play.type === 'single' || play.type === 'pair') && play.primaryValue >= 14 && player.hand.length >= 8) {
      score -= 75 + (play.primaryValue - 14) * 18;
    }
  } else {
    const target = state.tablePlay.play;
    const owner = state.players[state.tablePlay.owner];
    const urgentOpponent = !sameTeam(seat, owner.seat) && owner.hand.length <= 3;

    if (play.type === target.type && !isSpecialPlay(play)) {
      const overtake = play.primaryValue - target.primaryValue - 1;
      if (overtake > 0) {
        score -= overtake * (play.type === 'single' ? 28 : play.type === 'pair' ? 18 : 12);
      }
    }

    if (isSpecialPlay(play) && !urgentOpponent && !isSpecialPlay(target) && player.hand.length > 6) {
      score -= 180 + (play.bombSize ?? 0) * 26;
    }

    if (play.type === 'single' && play.primaryValue >= 15 && !urgentOpponent && player.hand.length >= 5) {
      score -= 90;
    }
  }

  if (play.wildCount > 0 && player.hand.length >= 7) {
    score -= play.wildCount * 22;
  }

  return score;
}

function scoreLegacyPlaysForContext(state: GameState, seat: Seat, plays: Play[], cache: PlanningCache): ScoredPlay[] {
  if (!state.tablePlay) {
    return scoreLegacyPlays(plays, (play) => scoreLegacyLeadPlay(state, seat, play, cache));
  }

  return scoreLegacyPlays(plays, (play) => scoreLegacyResponsePlay(state, seat, play, cache));
}

function scoreLegacyPlays(plays: Play[], scorePlay: (play: Play) => number): ScoredPlay[] {
  return plays
    .map((play) => ({
      play,
      score: scorePlay(play),
    }))
    .sort((left, right) => right.score - left.score);
}

function chooseLeadPlay(handSize: number, plays: Play[], hand: Card[]): Play {
  return [...plays].sort((left, right) => scoreLeadPlay(right, handSize, hand) - scoreLeadPlay(left, handSize, hand))[0];
}

function chooseResponsePlay(handSize: number, plays: Play[], hand: Card[], state: GameState): Play {
  return [...plays].sort((left, right) => scoreResponsePlay(right, handSize, hand, state) - scoreResponsePlay(left, handSize, hand, state))[0];
}

function chooseLegacyLeadPlay(state: GameState, seat: Seat, plays: Play[], cache: PlanningCache): ScoredPlay {
  return scoreLegacyPlays(plays, (play) => scoreLegacyLeadPlay(state, seat, play, cache))[0];
}

function chooseLegacyResponsePlay(state: GameState, seat: Seat, plays: Play[], cache: PlanningCache): ScoredPlay {
  return scoreLegacyPlays(plays, (play) => scoreLegacyResponsePlay(state, seat, play, cache))[0];
}

function scoreLegacyLeadPlay(state: GameState, seat: Seat, play: Play, cache: PlanningCache): number {
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
    score += 120_000;
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

function scoreLegacyResponsePlay(state: GameState, seat: Seat, play: Play, cache: PlanningCache): number {
  const player = state.players[seat];
  const target = state.tablePlay!.play;
  const owner = state.players[state.tablePlay!.owner];
  const nextSeat = getNextActiveSeat(state.players, seat);
  const nextPlayer = state.players[nextSeat];
  const nextHand = removePlayFromHand(player.hand, play);

  let score = evaluateHandPlan(nextHand, cache);
  score += play.cards.length * 18;
  score -= play.wildCount * 32;

  if (play.cards.length === player.hand.length) {
    score += 120_000;
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

    if (target.type === 'bomb' || target.type === 'straight-flush' || target.type === 'joker-bomb') {
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

function scorePassAction(state: GameState, seat: Seat, cache: PlanningCache): number {
  const player = state.players[seat];
  const owner = state.players[state.tablePlay!.owner];
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

  if (state.tablePlay!.play.type === 'single' && state.tablePlay!.play.primaryValue >= 14) {
    score += 30;
  }

  return score;
}

function evaluateBalancedState(state: GameState, rootTeam: Team, cache: PlanningCache): number {
  if (state.result) {
    const outcome = state.result.winnerTeam === rootTeam ? 1 : -1;
    return outcome * (300_000 + state.result.levelDelta * 60_000);
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
      score += factor * (52_000 - Math.max(0, finishIndex) * 7_500);
    } else {
      score -= factor * player.hand.length * 120;
    }
  }

  score += (opponentCards - teamCards) * 58;

  if (state.tablePlay) {
    score += sameTeam(state.tablePlay.owner, rootTeam === 0 ? 0 : 1) ? 95 : -95;
    score += sameTeam(state.tablePlay.owner, rootTeam === 0 ? 0 : 1)
      ? Math.max(0, 8 - state.players[state.tablePlay.owner].hand.length) * 14
      : -Math.max(0, 8 - state.players[state.tablePlay.owner].hand.length) * 18;
  }

  const currentFactor = state.players[state.currentPlayer].team === rootTeam ? 1 : -1;
  score += currentFactor * 24;

  return score;
}

function rolloutBalancedState(state: GameState, rootTeam: Team, pliesRemaining: number, cache: PlanningCache): number {
  if (pliesRemaining <= 0 || state.result) {
    return evaluateBalancedState(state, rootTeam, cache);
  }

  const seat = state.currentPlayer;
  const decision = chooseLegacyV1AiAction(state, seat);
  const nextState =
    decision.type === 'play' && decision.play ? applyPlay(state, seat, decision.play) : applyPass(state, seat);

  return (
    evaluateBalancedState(nextState, rootTeam, cache) * 0.42 +
    rolloutBalancedState(nextState, rootTeam, pliesRemaining - 1, cache) * 0.58
  );
}

function applyCandidateAction(state: GameState, seat: Seat, candidate: CandidateAction): GameState {
  if (candidate.type === 'pass') {
    return applyPass(state, seat);
  }

  return applyPlay(state, seat, candidate.play!);
}

function createPlanningCache(): PlanningCache {
  return {
    handScore: new Map(),
    minTurns: new Map(),
    greedyStats: new Map(),
  };
}

function evaluateHandPlan(hand: Card[], cache: PlanningCache): number {
  const key = handStateKey(hand);
  const cached = cache.handScore.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (hand.length === 0) {
    cache.handScore.set(key, 8_000);
    return 8_000;
  }

  const exactOut = generateAllPlays(hand).find((play) => play.cards.length === hand.length);
  if (exactOut) {
    const exactScore = 2_600 + hand.length * 24;
    cache.handScore.set(key, exactScore);
    return exactScore;
  }

  const turns = estimateMinTurns(hand, PLAN_SEARCH_DEPTH, cache);
  const stats = buildGreedyPlanStats(hand, cache);
  const wildCount = hand.filter((card) => card.isWild).length;

  const score =
    -turns * 235 -
    stats.singles * 26 -
    stats.wildSingles * 14 +
    stats.pairs * 10 +
    stats.triples * 16 +
    stats.fullHouses * 22 +
    stats.straights * 20 +
    stats.pairRuns * 28 +
    stats.tripleRuns * 34 +
    stats.bombs * 22 +
    stats.straightFlushes * 26 +
    stats.jokerBombs * 30 +
    wildCount * 10 -
    hand.length * 3;

  cache.handScore.set(key, score);
  return score;
}

function estimateMinTurns(hand: Card[], depth: number, cache: PlanningCache): number {
  if (hand.length === 0) {
    return 0;
  }

  const key = `${depth}:${handStateKey(hand)}`;
  const cached = cache.minTurns.get(key);
  if (cached !== undefined) {
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

function buildGreedyPlanStats(hand: Card[], cache: PlanningCache): PlanStats {
  const key = handStateKey(hand);
  const cached = cache.greedyStats.get(key);
  if (cached) {
    return cached;
  }

  const stats: PlanStats = {
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
    wildSingles: 0,
  };

  let remaining = [...hand];
  while (remaining.length > 0) {
    const plays = generateAllPlays(remaining);
    const nextPlay = rankPlanCandidates(plays, remaining)[0];

    stats.turns += 1;
    switch (nextPlay.type) {
      case 'single':
        stats.singles += 1;
        if (nextPlay.cards.some((card) => card.isWild)) {
          stats.wildSingles += 1;
        }
        break;
      case 'pair':
        stats.pairs += 1;
        break;
      case 'triple':
        stats.triples += 1;
        break;
      case 'full-house':
        stats.fullHouses += 1;
        break;
      case 'straight':
        stats.straights += 1;
        break;
      case 'pair-run':
        stats.pairRuns += 1;
        break;
      case 'triple-run':
        stats.tripleRuns += 1;
        break;
      case 'bomb':
        stats.bombs += 1;
        break;
      case 'straight-flush':
        stats.straightFlushes += 1;
        break;
      case 'joker-bomb':
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

function rankPlanCandidates(plays: Play[], hand: Card[]): Play[] {
  return [...plays].sort((left, right) => scorePlanCandidate(right, hand) - scorePlanCandidate(left, hand));
}

function scorePlanCandidate(play: Play, hand: Card[]): number {
  let score = play.cards.length * 90 + planTypeBonus(play);
  score -= play.wildCount * 24;

  if (play.cards.length === hand.length) {
    score += 100_000;
  }

  if (play.type === 'single') {
    score -= 90;
    score -= play.primaryValue * 3;
  }

  if (play.type === 'pair') {
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

function removePlayFromHand(hand: Card[], play: Play): Card[] {
  const playedIds = new Set(play.cards.map((card) => card.id));
  return hand.filter((card) => !playedIds.has(card.id));
}

function handStateKey(hand: Card[]): string {
  return hand
    .map((card) => card.id)
    .sort()
    .join('|');
}

function isUrgentOpponentTurn(state: GameState, seat: Seat): boolean {
  const owner = state.players[state.tablePlay!.owner];
  if (!sameTeam(seat, owner.seat) && owner.hand.length <= 3) {
    return true;
  }

  return state.players.some((player) => !sameTeam(seat, player.seat) && !player.finished && player.hand.length <= 2);
}

function scoreLeadPlay(play: Play, handSize: number, hand: Card[]): number {
  let score = play.cards.length * 18;
  score += typeLeadBonus(play);
  score -= play.primaryValue;
  score -= play.wildCount * 10;

  if (play.cards.length === handSize) {
    score += 2_000;
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

function scoreResponsePlay(play: Play, handSize: number, hand: Card[], state: GameState): number {
  let score = 200;
  score -= play.primaryValue * 2;
  score -= play.wildCount * 12;

  if (play.cards.length === handSize) {
    score += 2_000;
  }

  if (!isSpecialPlay(play)) {
    score += 80;
  } else if (state.players[state.tablePlay!.owner].hand.length <= 3) {
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

function typeLeadBonus(play: Play): number {
  switch (play.type) {
    case 'single':
      return 0;
    case 'pair':
      return 4;
    case 'triple':
      return 8;
    case 'full-house':
      return 16;
    case 'straight':
      return 15;
    case 'pair-run':
      return 18;
    case 'triple-run':
      return 20;
    case 'bomb':
      return 6;
    case 'straight-flush':
      return 10;
    case 'joker-bomb':
      return 12;
    default:
      return 0;
  }
}

function legacyLeadTypeBonus(play: Play): number {
  switch (play.type) {
    case 'single':
      return -15;
    case 'pair':
      return -2;
    case 'triple':
      return 16;
    case 'full-house':
      return 36;
    case 'straight':
      return 30;
    case 'pair-run':
      return 40;
    case 'triple-run':
      return 48;
    case 'bomb':
      return 12;
    case 'straight-flush':
      return 18;
    case 'joker-bomb':
      return 20;
    default:
      return 0;
  }
}

function planTypeBonus(play: Play): number {
  switch (play.type) {
    case 'single':
      return 0;
    case 'pair':
      return 18;
    case 'triple':
      return 28;
    case 'full-house':
      return 52;
    case 'straight':
      return 48;
    case 'pair-run':
      return 66;
    case 'triple-run':
      return 82;
    case 'bomb':
      return 34;
    case 'straight-flush':
      return 38;
    case 'joker-bomb':
      return 42;
    default:
      return 0;
  }
}

function getLeadRankPressure(play: Play): number {
  if (play.type === 'single' || play.type === 'pair') {
    return play.primaryValue * 5;
  }

  if (play.type === 'triple') {
    return play.primaryValue * 2;
  }

  return play.primaryValue;
}

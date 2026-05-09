import {
  chooseBalancedV2AiAction,
  chooseBaselineAiAction,
  chooseLegacyV20AiAction,
  chooseLegacyV21AiAction,
  chooseLegacyV22AiAction,
  chooseLegacyV23AiAction,
  chooseLegacyV24AiAction,
  chooseLegacyV25AiAction,
  chooseLegacyV26AiAction,
  chooseLegacyV27AiAction,
  chooseLegacyV28AiAction,
  chooseLegacyV29AiAction,
  chooseLegacyVRAiAction,
} from './ai-legacy';
import { filterLegalPlays, generateAllPlays, isSpecialPlay, sameTeam, usesRankPotentialBomb } from './rules';
import { applyPass, applyPlay, getNextActiveSeat } from './state';
import type { AiDecision, Card, GameState, Play, Seat, Team } from './types';

export {
  chooseBalancedV2AiAction,
  chooseBaselineAiAction,
  chooseLegacyV20AiAction,
  chooseLegacyV21AiAction,
  chooseLegacyV22AiAction,
  chooseLegacyV23AiAction,
  chooseLegacyV24AiAction,
  chooseLegacyV25AiAction,
  chooseLegacyV26AiAction,
  chooseLegacyV27AiAction,
  chooseLegacyV28AiAction,
  chooseLegacyV29AiAction,
  chooseLegacyVRAiAction,
};

export type AiProfile =
  | 'baseline'
  | 'legacy-v1'
  | `legacy-v2.${number}`
  | `legacy-v3.${number}`
  | 'legacy-vR'
  | 'balanced-v2';

interface ScoredPlay {
  play: Play;
  score: number;
}

export interface RankedAiActionCandidate {
  type: 'play' | 'pass';
  play?: Play;
  score: number;
}

export interface PlanningCache {
  handScore: Map<string, number>;
  minTurns: Map<string, number>;
  greedyStats: Map<string, PlanStats>;
}

export interface PlanStats {
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

export interface CandidateAction {
  type: 'pass' | 'play';
  play?: Play;
  priorScore: number;
}

const PLAN_SEARCH_DEPTH = 2;
const PLAN_BRANCH_FACTOR = 5;

export function chooseAiAction(state: GameState, seat: Seat, profile: AiProfile = 'legacy-v1'): AiDecision {
  if (profile.startsWith('legacy-v2.')) {
    const suffix = profile.slice('legacy-v2.'.length);
    if (suffix === '0') {
      return chooseLegacyV20AiAction(state, seat);
    }
    if (suffix === '1') {
      return chooseLegacyV21AiAction(state, seat);
    }
    if (suffix === '2') {
      return chooseLegacyV22AiAction(state, seat);
    }
    if (suffix === '3') {
      return chooseLegacyV23AiAction(state, seat);
    }
    if (suffix === '4') {
      return chooseLegacyV24AiAction(state, seat);
    }
    if (suffix === '5') {
      return chooseLegacyV25AiAction(state, seat);
    }
    if (suffix === '6') {
      return chooseLegacyV26AiAction(state, seat);
    }
    if (suffix === '7') {
      return chooseLegacyV27AiAction(state, seat);
    }
    if (suffix === '8') {
      return chooseLegacyV28AiAction(state, seat);
    }
    if (suffix === '9') {
      return chooseLegacyV29AiAction(state, seat);
    }

    return chooseLegacyV1AiAction(state, seat);
  }

  if (profile.startsWith('legacy-v3.')) {
    const suffix = profile.slice('legacy-v3.'.length);
    if (suffix === '0') {
      return chooseLegacyV30AiAction(state, seat);
    }
    return chooseLegacyV1AiAction(state, seat);
  }

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

const V30_ROOT_TOP_K_EARLY = 5;
const V30_ROOT_TOP_K_MID = 4;
const V30_ROOT_TOP_K_LATE = 3;
const V30_PRIOR_WEIGHT = 0.3;
const V30_V21_ADJUSTMENT_WEIGHT = 0.35;
const V30_ROLLOUT_MAX_STEPS_EARLY = 220;
const V30_ROLLOUT_MAX_STEPS_LATE = 180;

type V30RolloutPolicy = (state: GameState, seat: Seat, rootSeat: Seat) => AiDecision;

const V30_ROLLOUT_POLICIES: readonly V30RolloutPolicy[] = [
  (state, seat) => chooseLegacyV1AiAction(state, seat),
  (state, seat) => chooseLegacyV21AiAction(state, seat),
  (state, seat, rootSeat) =>
    sameTeam(rootSeat, seat) ? chooseLegacyV21AiAction(state, seat) : chooseLegacyV1AiAction(state, seat),
];

export function chooseLegacyV30AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  const latePhase = state.actionHistory.length >= 18 || player.hand.length <= 9;
  const rootTopK =
    player.hand.length <= 7
      ? V30_ROOT_TOP_K_LATE
      : latePhase
        ? V30_ROOT_TOP_K_MID
        : V30_ROOT_TOP_K_EARLY;
  const rolloutMaxSteps = latePhase ? V30_ROLLOUT_MAX_STEPS_LATE : V30_ROLLOUT_MAX_STEPS_EARLY;
  const rolloutPolicies = latePhase ? V30_ROLLOUT_POLICIES.slice(0, 2) : V30_ROLLOUT_POLICIES;

  const ranked = rankLegacyV1ActionCandidates(state, seat).slice(0, rootTopK);
  if (ranked.length === 0) {
    return { type: 'pass' };
  }
  if (ranked.length === 1) {
    return toAiDecision(ranked[0]);
  }

  const team = player.team;
  let best = ranked[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of ranked) {
    const action = toCandidateAction(candidate);
    const nextState = applyCandidateAction(state, seat, action);

    let terminalSum = 0;
    for (const policy of rolloutPolicies) {
      const terminalState = simulateV30PolicyToTerminal(nextState, seat, policy, rolloutMaxSteps);
      terminalSum += scoreTerminalTeamOutcome(terminalState, team);
    }
    const avgTerminal = terminalSum / rolloutPolicies.length;

    let score = candidate.score * V30_PRIOR_WEIGHT;
    score += scoreLegacyV21ActionAdjustment(state, seat, action) * V30_V21_ADJUSTMENT_WEIGHT;
    score += avgTerminal;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toAiDecision(best);
}

function simulateV30PolicyToTerminal(
  state: GameState,
  rootSeat: Seat,
  policy: V30RolloutPolicy,
  maxSteps: number,
): GameState {
  let current = state;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.result) {
      return current;
    }

    const actor = current.currentPlayer;
    const decision = policy(current, actor, rootSeat);
    current = applyAiDecision(current, actor, decision);
  }

  return current;
}

export function toAiDecision(candidate: RankedAiActionCandidate): AiDecision {
  if (candidate.type === 'play' && candidate.play) {
    return {
      type: 'play',
      play: candidate.play,
    };
  }

  return { type: 'pass' };
}

export function toCandidateAction(candidate: RankedAiActionCandidate): CandidateAction {
  if (candidate.type === 'play' && candidate.play) {
    return {
      type: 'play',
      play: candidate.play,
      priorScore: candidate.score,
    };
  }

  return {
    type: 'pass',
    priorScore: candidate.score,
  };
}

export function scoreLegacyV21ActionAdjustment(state: GameState, seat: Seat, action: CandidateAction): number {
  if (action.type === 'pass') {
    if (state.tablePlay && sameTeam(seat, state.tablePlay.owner)) {
      return 95;
    }
    return -10;
  }

  return state.tablePlay
    ? scoreLegacyV21ResponseAdjustment(state, seat, action.play!)
    : scoreLegacyV21LeadAdjustment(state, seat, action.play!);
}

export function applyAiDecision(state: GameState, seat: Seat, decision: AiDecision): GameState {
  if (decision.type === 'play' && decision.play) {
    return applyPlay(state, seat, decision.play);
  }

  return applyPass(state, seat);
}

function simulatePolicyToTerminal(
  state: GameState,
  maxSteps: number,
  chooseDecision: (state: GameState, seat: Seat) => AiDecision,
): GameState {
  let current = state;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.result) {
      return current;
    }

    const actor = current.currentPlayer;
    const decision = chooseDecision(current, actor);
    current = applyAiDecision(current, actor, decision);
  }

  return current;
}

function simulateProfileToTerminal(state: GameState, profile: AiProfile, maxSteps: number): GameState {
  let current = state;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.result) {
      return current;
    }

    const actor = current.currentPlayer;
    const decision = chooseAiAction(current, actor, profile);
    current = applyAiDecision(current, actor, decision);
  }

  return current;
}

function simulateProfileRolloutState(state: GameState, profile: AiProfile, plies: number): GameState {
  let current = state;
  for (let step = 0; step < plies; step += 1) {
    if (current.result) {
      return current;
    }

    const actor = current.currentPlayer;
    const decision = chooseAiAction(current, actor, profile);
    current = applyAiDecision(current, actor, decision);
  }

  return current;
}

export function scoreTerminalTeamOutcome(state: GameState, rootTeam: Team): number {
  if (state.result) {
    const sign = state.result.winnerTeam === rootTeam ? 1 : -1;
    return sign * (85_000 + state.result.levelDelta * 20_000);
  }

  const cache = createPlanningCache();
  return evaluateBalancedState(state, rootTeam, cache);
}

function evaluateExactPressureState(state: GameState, rootSeat: Seat, cache: PlanningCache): number {
  const rootTeam = state.players[rootSeat].team;
  let score = evaluateBalancedState(state, rootTeam, cache);

  if (state.result) {
    return score;
  }

  for (const player of state.players) {
    const factor = sameTeam(rootSeat, player.seat) ? 1 : -1;
    const allPlays = generateAllPlays(player.hand);
    const leadVolume = allPlays.length;
    score += factor * Math.min(leadVolume, 36) * 4;

    const finishNow = allPlays.some((play) => play.cards.length === player.hand.length);
    if (finishNow) {
      score += factor * 11_000;
    }
  }

  if (state.tablePlay) {
    const actor = state.currentPlayer;
    const legalReplies = filterLegalPlays(generateAllPlays(state.players[actor].hand), state.tablePlay.play);
    const canCollect = legalReplies.length > 0;
    if (!sameTeam(rootSeat, actor)) {
      score += canCollect ? -120 : 120;
    } else {
      score += canCollect ? 120 : -120;
    }
  }

  return score;
}

export function scoreLegacyV21LeadAdjustment(state: GameState, seat: Seat, play: Play): number {
  const player = state.players[seat];
  let score = 0;
  if ((play.type === 'single' || play.type === 'pair') && play.primaryValue >= 14 && player.hand.length >= 8) {
    score -= 95 + (play.primaryValue - 14) * 24;
  }

  if (isSpecialPlay(play) && player.hand.length > 6) {
    score -= 210 + (play.bombSize ?? 0) * 30;
  }

  if (play.type === 'straight' || play.type === 'pair-run' || play.type === 'triple-run' || play.type === 'full-house') {
    score += 24;
  }

  if (play.cards.length >= Math.max(5, player.hand.length - 1)) {
    score += 26;
  }

  return score;
}

export function scoreLegacyV21ResponseAdjustment(state: GameState, seat: Seat, play: Play): number {
  const player = state.players[seat];
  const owner = state.players[state.tablePlay!.owner];
  const target = state.tablePlay!.play;
  let score = 0;

  if (!isSpecialPlay(play) && play.type === target.type) {
    const overtake = Math.max(0, play.primaryValue - target.primaryValue - 1);
    score -= overtake * (play.type === 'single' ? 30 : play.type === 'pair' ? 18 : 12);
  }

  if (isSpecialPlay(play) && !isUrgentOpponentTurn(state, seat) && player.hand.length >= 7 && !isSpecialPlay(target)) {
    score -= 220 + (play.bombSize ?? 0) * 32;
  }

  if (isSpecialPlay(play) && (owner.hand.length <= 2 || player.hand.length <= 5)) {
    score += 95;
  }

  if (play.type === 'single' && play.primaryValue >= 15 && owner.hand.length >= 4 && player.hand.length >= 6) {
    score -= 80;
  }

  return score;
}

export function scoreLegacyPlays(plays: Play[], scorePlay: (play: Play) => number): ScoredPlay[] {
  return plays
    .map((play) => ({
      play,
      score: scorePlay(play),
    }))
    .sort((left, right) => right.score - left.score);
}

function chooseLegacyLeadPlay(state: GameState, seat: Seat, plays: Play[], cache: PlanningCache): ScoredPlay {
  return scoreLegacyPlays(plays, (play) => scoreLegacyLeadPlay(state, seat, play, cache))[0];
}

function chooseLegacyResponsePlay(state: GameState, seat: Seat, plays: Play[], cache: PlanningCache): ScoredPlay {
  return scoreLegacyPlays(plays, (play) => scoreLegacyResponsePlay(state, seat, play, cache))[0];
}

export function scoreLegacyLeadPlay(state: GameState, seat: Seat, play: Play, cache: PlanningCache): number {
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

export function scoreLegacyResponsePlay(state: GameState, seat: Seat, play: Play, cache: PlanningCache): number {
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

export function scorePassAction(state: GameState, seat: Seat, cache: PlanningCache): number {
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

export function evaluateBalancedState(state: GameState, rootTeam: Team, cache: PlanningCache): number {
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

export function applyCandidateAction(state: GameState, seat: Seat, candidate: CandidateAction): GameState {
  if (candidate.type === 'pass') {
    return applyPass(state, seat);
  }

  return applyPlay(state, seat, candidate.play!);
}

export function createPlanningCache(): PlanningCache {
  return {
    handScore: new Map(),
    minTurns: new Map(),
    greedyStats: new Map(),
  };
}

export function evaluateHandPlan(hand: Card[], cache: PlanningCache): number {
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

export function buildGreedyPlanStats(hand: Card[], cache: PlanningCache): PlanStats {
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

export function removePlayFromHand(hand: Card[], play: Play): Card[] {
  const playedIds = new Set(play.cards.map((card) => card.id));
  return hand.filter((card) => !playedIds.has(card.id));
}

function handStateKey(hand: Card[]): string {
  return hand
    .map((card) => card.id)
    .sort()
    .join('|');
}

export function isUrgentOpponentTurn(state: GameState, seat: Seat): boolean {
  const owner = state.players[state.tablePlay!.owner];
  if (!sameTeam(seat, owner.seat) && owner.hand.length <= 3) {
    return true;
  }

  return state.players.some((player) => !sameTeam(seat, player.seat) && !player.finished && player.hand.length <= 2);
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

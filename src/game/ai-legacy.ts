import {
  applyAiDecision,
  applyCandidateAction,
  type CandidateAction,
  chooseLegacyV1AiAction,
  createPlanningCache,
  evaluateBalancedState,
  isUrgentOpponentTurn,
  rankLegacyV1ActionCandidates,
  scoreLegacyLeadPlay,
  scoreLegacyPlays,
  scoreLegacyResponsePlay,
  scoreLegacyV21ActionAdjustment,
  scoreLegacyV21LeadAdjustment,
  scoreLegacyV21ResponseAdjustment,
  scorePassAction,
  scoreTerminalTeamOutcome,
  toAiDecision,
  toCandidateAction,
  type PlanningCache,
} from './ai';
import { filterLegalPlays, generateAllPlays, isSpecialPlay, sameTeam, usesRankPotentialBomb } from './rules';
import { applyPass, applyPlay } from './state';
import type { AiDecision, Card, GameState, Play, Seat, Team } from './types';

const BALANCED_ROLLOUT_PLIES = 5;
const BALANCED_BRANCH_FACTOR = 6;
const LEGACY_VR_TOP_K = 3;
const LEGACY_VR_RANK_WEIGHTS = [3, 2, 1] as const;

interface LegacySignalProfile {
  attackBias: number;
  supportBias: number;
  lane: Play['type'] | null;
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

export function chooseLegacyV20AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  const cache = createPlanningCache();
  const team = player.team;
  const baselineScore = evaluateBalancedState(state, team, cache);
  const ranked = rankLegacyV1ActionCandidates(state, seat).slice(0, 8);
  const signals = buildLegacySignalProfiles(state);

  let best = ranked[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of ranked) {
    const action = toCandidateAction(candidate);
    const nextState = applyCandidateAction(state, seat, action);
    let score = candidate.score * 0.58;
    score += (evaluateBalancedState(nextState, team, cache) - baselineScore) * 0.92;
    score += rolloutBalancedState(nextState, team, 3, cache) * 0.22;
    score += scoreLegacyV20SignalAdjustment(state, seat, action, signals);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toAiDecision(best);
}

export function chooseLegacyV21AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  const cache = createPlanningCache();
  if (!state.tablePlay) {
    const bestLead = scoreLegacyPlays(legalPlays, (play) => scoreLegacyLeadPlay(state, seat, play, cache) + scoreLegacyV21LeadAdjustment(state, seat, play))[0];
    return {
      type: 'play',
      play: bestLead.play,
    };
  }

  if (sameTeam(seat, state.tablePlay.owner)) {
    return { type: 'pass' };
  }

  const passScore = scorePassAction(state, seat, cache);
  const ranked = scoreLegacyPlays(legalPlays, (play) => scoreLegacyResponsePlay(state, seat, play, cache) + scoreLegacyV21ResponseAdjustment(state, seat, play));
  const best = ranked[0];
  const bestOrdinary = ranked.find((entry) => !isSpecialPlay(entry.play));
  const urgentOpponent = isUrgentOpponentTurn(state, seat);

  if (bestOrdinary && bestOrdinary.score >= best.score - 130 && bestOrdinary.score >= passScore - 15) {
    return { type: 'play', play: bestOrdinary.play };
  }

  if (!isSpecialPlay(best.play) && best.score >= passScore - 10) {
    return { type: 'play', play: best.play };
  }

  if (isSpecialPlay(best.play) && urgentOpponent && best.score >= passScore - 40) {
    return { type: 'play', play: best.play };
  }

  return { type: 'pass' };
}

export function chooseLegacyV22AiAction(state: GameState, seat: Seat): AiDecision {
  if (seat % 2 === 0) {
    return chooseLegacyV1AiAction(state, seat);
  }

  return chooseLegacyV21AiAction(state, seat);
}

export function chooseLegacyV23AiAction(state: GameState, seat: Seat): AiDecision {
  if (seat % 2 === 0) {
    return chooseLegacyV21AiAction(state, seat);
  }

  return chooseLegacyV1AiAction(state, seat);
}

export function chooseLegacyV24AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  const cache = createPlanningCache();
  const team = player.team;
  const baselineScore = evaluateBalancedState(state, team, cache);
  const ranked = rankLegacyV1ActionCandidates(state, seat).slice(0, 6);

  let best = ranked[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of ranked) {
    const action = toCandidateAction(candidate);
    const nextState = applyCandidateAction(state, seat, action);
    let score = candidate.score * 0.55;
    score += (evaluateBalancedState(nextState, team, cache) - baselineScore) * 1.05;
    score += rolloutBalancedState(nextState, team, 2, cache) * 0.18;
    score += scoreLegacyV21ActionAdjustment(state, seat, action);

    if (!nextState.result) {
      const replySeat = nextState.currentPlayer;
      const reply = chooseLegacyV1AiAction(nextState, replySeat);
      const replyState = applyAiDecision(nextState, replySeat, reply);
      score += (evaluateBalancedState(replyState, team, cache) - baselineScore) * 0.62;
      if (!sameTeam(seat, replySeat)) {
        score -= 16;
      }
    }

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toAiDecision(best);
}

export function chooseLegacyV25AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  const cache = createPlanningCache();
  const team = player.team;
  const baselineScore = evaluateBalancedState(state, team, cache);
  const ranked = rankLegacyV1ActionCandidates(state, seat).slice(0, 4);

  let best = ranked[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of ranked) {
    const action = toCandidateAction(candidate);
    const nextState = applyCandidateAction(state, seat, action);
    const rolloutState = simulateLegacyRolloutState(nextState, 8);
    let score = candidate.score * 0.45;
    score += (evaluateBalancedState(nextState, team, cache) - baselineScore) * 0.65;
    score += (evaluateBalancedState(rolloutState, team, cache) - baselineScore) * 0.9;
    score += scoreLegacyV21ActionAdjustment(state, seat, action) * 0.5;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toAiDecision(best);
}

export function chooseLegacyV26AiAction(state: GameState, seat: Seat): AiDecision {
  if (seat % 2 === 0) {
    return chooseLegacyV1AiAction(state, seat);
  }

  const player = state.players[seat];
  if (state.actionHistory.length >= 14 || player.hand.length <= 9) {
    return chooseLegacyV1AiAction(state, seat);
  }

  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  const team = player.team;
  const ranked = rankLegacyV1ActionCandidates(state, seat).slice(0, 4);
  let best = ranked[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of ranked) {
    const action = toCandidateAction(candidate);
    const nextState = applyCandidateAction(state, seat, action);
    const terminalState = simulateLegacyV1ToTerminal(nextState, 220);
    let score = candidate.score * 0.22;
    score += scoreTerminalTeamOutcome(terminalState, team);
    score += scoreLegacyV21ActionAdjustment(state, seat, action);

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toAiDecision(best);
}

export function chooseLegacyV27AiAction(state: GameState, seat: Seat): AiDecision {
  const player = state.players[seat];
  const legalPlays = filterLegalPlays(generateAllPlays(player.hand), state.tablePlay?.play ?? null);
  if (legalPlays.length === 0) {
    return { type: 'pass' };
  }

  const finishNow = legalPlays.find((play) => play.cards.length === player.hand.length);
  if (finishNow) {
    return { type: 'play', play: finishNow };
  }

  if (state.actionHistory.length >= 14 || player.hand.length <= 9) {
    return chooseLegacyV26AiAction(state, seat);
  }

  const team = player.team;
  const ranked = rankLegacyV1ActionCandidates(state, seat).slice(0, 4);
  let best = ranked[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of ranked) {
    const action = toCandidateAction(candidate);
    const nextState = applyCandidateAction(state, seat, action);
    const terminalState = simulateLegacyV1ToTerminal(nextState, 220);
    let score = candidate.score * 0.35;
    score += scoreLegacyV21ActionAdjustment(state, seat, action) * 0.4;
    score += scoreTerminalTeamOutcome(terminalState, team);

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toAiDecision(best);
}

export function chooseLegacyV28AiAction(state: GameState, seat: Seat): AiDecision {
  return chooseLegacyV27AiAction(state, seat);
}

export function chooseLegacyV29AiAction(state: GameState, seat: Seat): AiDecision {
  if (state.actionHistory.length >= 16 || state.players[seat].hand.length <= 10) {
    return chooseLegacyV26AiAction(state, seat);
  }

  return chooseLegacyV27AiAction(state, seat);
}

function simulateLegacyRolloutState(state: GameState, plies: number): GameState {
  let current = state;
  for (let ply = 0; ply < plies; ply += 1) {
    if (current.result) {
      return current;
    }

    const actor = current.currentPlayer;
    const decision = chooseLegacyV1AiAction(current, actor);
    current = applyAiDecision(current, actor, decision);
  }

  return current;
}

function simulateLegacyV1ToTerminal(state: GameState, maxSteps: number): GameState {
  let current = state;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.result) {
      return current;
    }

    const actor = current.currentPlayer;
    const decision = chooseLegacyV1AiAction(current, actor);
    current = applyAiDecision(current, actor, decision);
  }

  return current;
}

function buildLegacySignalProfiles(state: GameState): Record<Seat, LegacySignalProfile> {
  const profiles: Record<Seat, LegacySignalProfile> = {
    0: { attackBias: 0, supportBias: 0, lane: null },
    1: { attackBias: 0, supportBias: 0, lane: null },
    2: { attackBias: 0, supportBias: 0, lane: null },
    3: { attackBias: 0, supportBias: 0, lane: null },
  };
  const laneCounts: Record<Seat, Map<Play['type'], number>> = {
    0: new Map(),
    1: new Map(),
    2: new Map(),
    3: new Map(),
  };

  for (const entry of state.actionHistory) {
    const actor = entry.seat;
    if (entry.play) {
      const laneCount = laneCounts[actor].get(entry.play.type) ?? 0;
      laneCounts[actor].set(entry.play.type, laneCount + 1);
      if (entry.play.cards.length >= 5 || isSpecialPlay(entry.play)) {
        profiles[actor].attackBias += isSpecialPlay(entry.play) ? 2.2 : 1.1;
      }
      continue;
    }

    if (entry.tableOwnerAfter === null) {
      continue;
    }

    if (sameTeam(actor, entry.tableOwnerAfter)) {
      profiles[actor].supportBias += 1.5;
    } else {
      profiles[actor].supportBias += 0.45;
    }
  }

  for (const seat of [0, 1, 2, 3] as const) {
    let bestLane: Play['type'] | null = null;
    let bestCount = 0;
    for (const [lane, count] of laneCounts[seat]) {
      if (count > bestCount) {
        bestCount = count;
        bestLane = lane;
      }
    }
    profiles[seat].lane = bestLane;
  }

  return profiles;
}

function scoreLegacyV20SignalAdjustment(
  state: GameState,
  seat: Seat,
  candidate: CandidateAction,
  signals: Record<Seat, LegacySignalProfile>,
): number {
  const player = state.players[seat];
  const teammateSeat = ((seat + 2) % 4) as Seat;
  const teammate = state.players[teammateSeat];
  const opponents = state.players.filter((other) => !sameTeam(seat, other.seat) && !other.finished);
  const minOpponentCards = opponents.reduce((min, other) => Math.min(min, other.hand.length), 27);
  const teamLikelyAttack = signals[teammateSeat].attackBias - signals[teammateSeat].supportBias >= 1.2;

  if (candidate.type === 'pass') {
    if (state.tablePlay && sameTeam(seat, state.tablePlay.owner)) {
      return 95;
    }

    if (minOpponentCards <= 2) {
      return -130;
    }

    return 0;
  }

  const play = candidate.play!;
  let score = 0;

  if (!state.tablePlay) {
    if (play.type === signals[seat].lane) {
      score += 16;
    }

    if (play.type === signals[teammateSeat].lane && teamLikelyAttack) {
      score += 30;
    }

    if ((play.type === 'single' || play.type === 'pair') && play.primaryValue >= 14 && player.hand.length >= 8) {
      score -= 72;
    }

    if (isSpecialPlay(play) && player.hand.length > 6 && minOpponentCards > 2) {
      score -= 170;
    }
  } else {
    const owner = state.players[state.tablePlay.owner];
    const target = state.tablePlay.play;
    const urgentOpponent = !sameTeam(seat, owner.seat) && owner.hand.length <= 3;

    if (sameTeam(seat, owner.seat) && play.cards.length !== player.hand.length) {
      score -= 170;
    }

    if (!isSpecialPlay(play) && play.type === target.type) {
      const overtake = Math.max(0, play.primaryValue - target.primaryValue - 1);
      score -= overtake * (play.type === 'single' ? 30 : 16);
    }

    if (!urgentOpponent && isSpecialPlay(play) && player.hand.length > 6 && !isSpecialPlay(target)) {
      score -= 170 + (play.bombSize ?? 0) * 20;
    }

    if (urgentOpponent && isSpecialPlay(play)) {
      score += 90;
    }
  }

  if (teammate.hand.length <= 3 && play.cards.length <= 3 && !isSpecialPlay(play)) {
    score += 38;
  }

  return score;
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

function scoreLegacyPlaysForContext(state: GameState, seat: Seat, plays: Play[], cache: PlanningCache) {
  if (!state.tablePlay) {
    return scoreLegacyPlays(plays, (play) => scoreLegacyLeadPlay(state, seat, play, cache));
  }

  return scoreLegacyPlays(plays, (play) => scoreLegacyResponsePlay(state, seat, play, cache));
}

function chooseLeadPlay(handSize: number, plays: Play[], hand: Card[]): Play {
  return [...plays].sort((left, right) => scoreLeadPlay(right, handSize, hand) - scoreLeadPlay(left, handSize, hand))[0];
}

function chooseResponsePlay(handSize: number, plays: Play[], hand: Card[], state: GameState): Play {
  return [...plays].sort((left, right) => scoreResponsePlay(right, handSize, hand, state) - scoreResponsePlay(left, handSize, hand, state))[0];
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

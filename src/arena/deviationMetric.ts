import type { OpenRouterRerankDecisionEvent } from './openrouter';

export interface DeviationMetric {
  totalTurns: number;
  skippedTurns: number;
  rerankedTurns: number;
  chosenLegacyTop1: number;
  deviatedFromLegacyTop: number;
  chosenLegacyFallback: number;
  deviatedFromLegacyFallback: number;
  chosenLegacyRankSum: number;
  chosenLegacyRankSamples: number;
  fallbackLegacyRankSum: number;
  fallbackLegacyRankSamples: number;
  candidateCountSum: number;
  sampleDeviations: string[];
}

export function createDeviationMetric(): DeviationMetric {
  return {
    totalTurns: 0,
    skippedTurns: 0,
    rerankedTurns: 0,
    chosenLegacyTop1: 0,
    deviatedFromLegacyTop: 0,
    chosenLegacyFallback: 0,
    deviatedFromLegacyFallback: 0,
    chosenLegacyRankSum: 0,
    chosenLegacyRankSamples: 0,
    fallbackLegacyRankSum: 0,
    fallbackLegacyRankSamples: 0,
    candidateCountSum: 0,
    sampleDeviations: [],
  };
}

export function mergeDeviationMetric(left: DeviationMetric, right: DeviationMetric): DeviationMetric {
  return {
    totalTurns: left.totalTurns + right.totalTurns,
    skippedTurns: left.skippedTurns + right.skippedTurns,
    rerankedTurns: left.rerankedTurns + right.rerankedTurns,
    chosenLegacyTop1: left.chosenLegacyTop1 + right.chosenLegacyTop1,
    deviatedFromLegacyTop: left.deviatedFromLegacyTop + right.deviatedFromLegacyTop,
    chosenLegacyFallback: left.chosenLegacyFallback + right.chosenLegacyFallback,
    deviatedFromLegacyFallback: left.deviatedFromLegacyFallback + right.deviatedFromLegacyFallback,
    chosenLegacyRankSum: left.chosenLegacyRankSum + right.chosenLegacyRankSum,
    chosenLegacyRankSamples: left.chosenLegacyRankSamples + right.chosenLegacyRankSamples,
    fallbackLegacyRankSum: left.fallbackLegacyRankSum + right.fallbackLegacyRankSum,
    fallbackLegacyRankSamples: left.fallbackLegacyRankSamples + right.fallbackLegacyRankSamples,
    candidateCountSum: left.candidateCountSum + right.candidateCountSum,
    sampleDeviations: [...left.sampleDeviations, ...right.sampleDeviations].slice(0, 12),
  };
}

export function recordDeviationMetric(target: DeviationMetric, event: OpenRouterRerankDecisionEvent): void {
  target.totalTurns += 1;
  target.candidateCountSum += event.candidateCount;

  if (event.skipped) {
    target.skippedTurns += 1;
    return;
  }

  target.rerankedTurns += 1;

  if (event.chosenLegacyRank !== null) {
    target.chosenLegacyRankSum += event.chosenLegacyRank;
    target.chosenLegacyRankSamples += 1;
    if (event.chosenLegacyRank === 1) {
      target.chosenLegacyTop1 += 1;
    }
  }

  if (event.fallbackLegacyRank !== null) {
    target.fallbackLegacyRankSum += event.fallbackLegacyRank;
    target.fallbackLegacyRankSamples += 1;
  }

  if (event.deviatedFromLegacyTop) {
    target.deviatedFromLegacyTop += 1;
  }

  if (event.deviatedFromLegacyFallback) {
    target.deviatedFromLegacyFallback += 1;
    addDeviationSample(
      target,
      `seat=${event.seat ?? '-'} chose=${JSON.stringify(event.chosenAction)} fallback=${JSON.stringify(event.fallbackAction)} chosenRank=${event.chosenLegacyRank ?? '-'} fallbackRank=${event.fallbackLegacyRank ?? '-'} candidates=${event.candidateCount}`,
    );
  } else {
    target.chosenLegacyFallback += 1;
  }
}

export function summarizeDeviationMetric(target: DeviationMetric) {
  return {
    totalTurns: target.totalTurns,
    skippedTurns: target.skippedTurns,
    rerankedTurns: target.rerankedTurns,
    chosenLegacyTop1: target.chosenLegacyTop1,
    deviatedFromLegacyTop: target.deviatedFromLegacyTop,
    deviationRateFromLegacyTop:
      target.rerankedTurns > 0 ? target.deviatedFromLegacyTop / target.rerankedTurns : 0,
    chosenLegacyFallback: target.chosenLegacyFallback,
    deviatedFromLegacyFallback: target.deviatedFromLegacyFallback,
    deviationRateFromLegacyFallback:
      target.rerankedTurns > 0 ? target.deviatedFromLegacyFallback / target.rerankedTurns : 0,
    averageChosenLegacyRank:
      target.chosenLegacyRankSamples > 0 ? target.chosenLegacyRankSum / target.chosenLegacyRankSamples : 0,
    averageFallbackLegacyRank:
      target.fallbackLegacyRankSamples > 0 ? target.fallbackLegacyRankSum / target.fallbackLegacyRankSamples : 0,
    averageCandidateCount: target.totalTurns > 0 ? target.candidateCountSum / target.totalTurns : 0,
    sampleDeviations: target.sampleDeviations,
  };
}

function addDeviationSample(target: DeviationMetric, message: string): void {
  if (target.sampleDeviations.length >= 6) {
    return;
  }

  target.sampleDeviations.push(message);
}

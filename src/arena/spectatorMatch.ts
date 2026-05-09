import { createHeuristicAgent, GuandanArenaMatch } from './engine';
import {
  createOpenRouterAgent,
  createOpenRouterRerankerAgent,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_RERANKER_MODEL,
  type OpenRouterStatusEvent,
} from './openrouter';
import { createScoreNetSeatAgent } from './scoreNetSeatAgent';
import type { SpectatorArenaConfig, SpectatorGlobalConfig, SpectatorSeatConfig } from './spectatorConfig';
import type { GameState, Seat } from '../game/types';

export function createSpectatorMatch(
  config: SpectatorArenaConfig,
  options?: {
    initialState?: GameState;
    onLlmStatus?: (entry: OpenRouterStatusEvent) => void;
    siteUrl?: string;
  },
): GuandanArenaMatch {
  return new GuandanArenaMatch({
    initialState: options?.initialState,
    agents: [
      resolveSpectatorSeatAgent(config.seatConfigs[0], config.globalConfig, 0, options),
      resolveSpectatorSeatAgent(config.seatConfigs[1], config.globalConfig, 1, options),
      resolveSpectatorSeatAgent(config.seatConfigs[2], config.globalConfig, 2, options),
      resolveSpectatorSeatAgent(config.seatConfigs[3], config.globalConfig, 3, options),
    ],
  });
}

export function resolveSpectatorSeatAgent(
  seatConfig: SpectatorSeatConfig,
  globalConfig: SpectatorGlobalConfig,
  seat: Seat,
  options?: {
    onLlmStatus?: (entry: OpenRouterStatusEvent) => void;
    siteUrl?: string;
  },
) {
  if (seatConfig.mode === 'builtin-balanced-v2') {
    return createHeuristicAgent({
      id: `builtin-balanced-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Balanced`,
      profile: 'balanced-v2',
    });
  }

  if (seatConfig.mode === 'builtin-legacy-vR') {
    return createHeuristicAgent({
      id: `builtin-legacy-vr-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Legacy vR`,
      profile: 'legacy-vR',
    });
  }

  if (seatConfig.mode === 'builtin-legacy-v3') {
    return createHeuristicAgent({
      id: `builtin-legacy-v3-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Legacy v3.0`,
      profile: 'legacy-v3.0',
    });
  }

  if (seatConfig.mode === 'builtin-legacy-v1') {
    return createHeuristicAgent({
      id: `builtin-legacy-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Legacy`,
      profile: 'legacy-v1',
    });
  }

  if (seatConfig.mode === 'builtin-baseline') {
    return createHeuristicAgent({
      id: `builtin-baseline-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Baseline`,
      profile: 'baseline',
    });
  }

  if (seatConfig.mode === 'scorenet-ppo') {
    return createScoreNetSeatAgent({
      id: `scorenet-ppo-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Latest PPO ScoreNet`,
      seat,
    });
  }

  if (seatConfig.mode === 'llmreranker') {
    return createOpenRouterRerankerAgent({
      id: `llmreranker-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} LLM Reranker`,
      apiKey: seatConfig.apiKey.trim() || globalConfig.apiKey.trim(),
      model: seatConfig.model.trim() || OPENROUTER_DEFAULT_RERANKER_MODEL,
      baseUrl: globalConfig.baseUrl.trim() || OPENROUTER_DEFAULT_BASE_URL,
      siteName: 'Guandan Arena',
      siteUrl: options?.siteUrl,
      seat,
      onStatus: options?.onLlmStatus,
    });
  }

  return createOpenRouterAgent({
    id: `openrouter-seat-${seat}`,
    label: seatConfig.label || `Seat ${seat} LLM`,
    apiKey: seatConfig.apiKey.trim() || globalConfig.apiKey.trim(),
    model: seatConfig.model.trim(),
    baseUrl: globalConfig.baseUrl.trim() || OPENROUTER_DEFAULT_BASE_URL,
    siteName: 'Guandan Arena',
    siteUrl: options?.siteUrl,
    seat,
    onStatus: options?.onLlmStatus,
  });
}

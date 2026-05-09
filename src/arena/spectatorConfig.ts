import type { Seat } from '../game/types';
import { OPENROUTER_DEFAULT_BASE_URL, OPENROUTER_DEFAULT_RERANKER_MODEL } from './openrouter';

export const LOCAL_STORAGE_KEY = 'guandan-openrouter-spectator-v1';

export type SeatAgentMode =
  | 'builtin-baseline'
  | 'builtin-legacy-v1'
  | 'builtin-legacy-v3'
  | 'builtin-legacy-vR'
  | 'builtin-balanced-v2'
  | 'scorenet-ppo'
  | 'openrouter'
  | 'llmreranker';
export type SpectatorSeatConfigMap = Record<Seat, SpectatorSeatConfig>;

export interface SpectatorGlobalConfig {
  baseUrl: string;
  apiKey: string;
}

export interface SpectatorSeatConfig {
  mode: SeatAgentMode;
  label: string;
  model: string;
  apiKey: string;
}

export interface SpectatorArenaConfig {
  globalConfig: SpectatorGlobalConfig;
  seatConfigs: SpectatorSeatConfigMap;
}

export interface OpenRouterModelOption {
  value: string;
  label: string;
}

export const AVAILABLE_OPENROUTER_MODELS: OpenRouterModelOption[] = [
  {
    value: 'moonshotai/kimi-k2.5',
    label: 'Kimi K2.5',
  },
  {
    value: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
  },
  {
    value: 'google/gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B A4B Instruct',
  },
  {
    value: 'deepseek/deepseek-chat-v3-0324',
    label: 'DeepSeek Chat V3 0324',
  },
  {
    value: 'tencent/hy3-preview:free',
    label: 'Tencent HY3 Preview (free)',
  },
];

export const DEFAULT_GLOBAL_CONFIG: SpectatorGlobalConfig = {
  baseUrl: OPENROUTER_DEFAULT_BASE_URL,
  apiKey: '',
};

export const DEFAULT_SEAT_CONFIGS: SpectatorSeatConfigMap = {
  0: { mode: 'builtin-legacy-v3', label: '', model: '', apiKey: '' },
  1: { mode: 'builtin-legacy-v3', label: '', model: '', apiKey: '' },
  2: { mode: 'builtin-legacy-v3', label: '', model: '', apiKey: '' },
  3: { mode: 'builtin-legacy-v3', label: '', model: '', apiKey: '' },
};

export function loadPersistedSpectatorConfig(): SpectatorArenaConfig {
  if (typeof window === 'undefined') {
    return createDefaultSpectatorConfig();
  }

  const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) {
    return createDefaultSpectatorConfig();
  }

  try {
    const parsed = JSON.parse(raw) as {
      globalConfig?: Partial<SpectatorGlobalConfig>;
      seatConfigs?: Partial<Record<Seat, Partial<SpectatorSeatConfig>>>;
    };

    return {
      globalConfig: {
        ...DEFAULT_GLOBAL_CONFIG,
        ...parsed.globalConfig,
      },
      seatConfigs: {
        0: normalizeSeatConfig({ ...DEFAULT_SEAT_CONFIGS[0], ...parsed.seatConfigs?.[0] }),
        1: normalizeSeatConfig({ ...DEFAULT_SEAT_CONFIGS[1], ...parsed.seatConfigs?.[1] }),
        2: normalizeSeatConfig({ ...DEFAULT_SEAT_CONFIGS[2], ...parsed.seatConfigs?.[2] }),
        3: normalizeSeatConfig({ ...DEFAULT_SEAT_CONFIGS[3], ...parsed.seatConfigs?.[3] }),
      },
    };
  } catch {
    return createDefaultSpectatorConfig();
  }
}

export function persistSpectatorConfig(config: SpectatorArenaConfig): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(config));
}

export function validateSpectatorConfig(config: SpectatorArenaConfig): string | null {
  const openRouterSeats = ([0, 1, 2, 3] as const).filter((seat) =>
    config.seatConfigs[seat].mode === 'openrouter' || config.seatConfigs[seat].mode === 'llmreranker',
  );

  if (openRouterSeats.length === 0) {
    return null;
  }

  if (!config.globalConfig.baseUrl.trim()) {
    return 'OpenRouter Base URL 不能为空。';
  }

  for (const seat of openRouterSeats) {
    const seatConfig = config.seatConfigs[seat];
    if (seatConfig.mode === 'openrouter' && !seatConfig.model.trim()) {
      return `Seat ${seat} 还没有填写 model。`;
    }

    if (!(seatConfig.apiKey.trim() || config.globalConfig.apiKey.trim())) {
      return `Seat ${seat} 缺少 API key。你可以填全局 key，或者只给这个 seat 填覆盖 key。`;
    }
  }

  return null;
}

export function createDefaultSpectatorConfig(): SpectatorArenaConfig {
  return {
    globalConfig: { ...DEFAULT_GLOBAL_CONFIG },
    seatConfigs: {
      0: { ...DEFAULT_SEAT_CONFIGS[0] },
      1: { ...DEFAULT_SEAT_CONFIGS[1] },
      2: { ...DEFAULT_SEAT_CONFIGS[2] },
      3: { ...DEFAULT_SEAT_CONFIGS[3] },
    },
  };
}

export function getSeatTitle(seat: Seat): string {
  if (seat === 0) {
    return '下家 / 我方';
  }

  if (seat === 2) {
    return '上家 / 我方';
  }

  return '对手';
}

export function getSeatDisplayLabel(config: SpectatorSeatConfig): string {
  if (config.mode === 'builtin-balanced-v2') {
    return config.label || 'guandan-ai v2 balanced';
  }

  if (config.mode === 'builtin-legacy-vR') {
    return config.label || 'guandan-ai vR';
  }

  if (config.mode === 'builtin-legacy-v3') {
    return config.label || 'legacy v3';
  }

  if (config.mode === 'builtin-legacy-v1') {
    return config.label || 'guandan-ai v1';
  }

  if (config.mode === 'builtin-baseline') {
    return config.label || '基础内置 heuristic';
  }

  if (config.mode === 'scorenet-ppo') {
    return config.label || 'Latest PPO ScoreNet';
  }

  if (config.mode === 'llmreranker') {
    return config.label || 'LLM Reranker';
  }

  return config.label || getOpenRouterModelLabel(config.model) || 'OpenRouter LLM';
}

export function getSeatSubtitle(config: SpectatorSeatConfig): string {
  if (config.mode === 'builtin-balanced-v2') {
    return `${getSeatDisplayLabel(config)} · balanced`;
  }

  if (config.mode === 'builtin-legacy-vR') {
    return `${getSeatDisplayLabel(config)} · weighted top-5`;
  }

  if (config.mode === 'builtin-legacy-v3') {
    return `${getSeatDisplayLabel(config)} · policy ensemble`;
  }

  if (config.mode === 'builtin-legacy-v1') {
    return `${getSeatDisplayLabel(config)} · legacy`;
  }

  if (config.mode === 'builtin-baseline') {
    return `${getSeatDisplayLabel(config)} · 基础启发式`;
  }

  if (config.mode === 'scorenet-ppo') {
    return `${getSeatDisplayLabel(config)} · learned policy`;
  }

  if (config.mode === 'llmreranker') {
    return `${getSeatDisplayLabel(config)} · ${getOpenRouterModelLabel(config.model || OPENROUTER_DEFAULT_RERANKER_MODEL)}`;
  }

  return `${getSeatDisplayLabel(config)} · ${getOpenRouterModelLabel(config.model) || '未设模型'}`;
}

export function trimEndpoint(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/api\/v1\/chat\/completions$/, '');
}

function normalizeSeatConfig(config: SpectatorSeatConfig): SpectatorSeatConfig {
  return {
    ...config,
    mode: normalizeSeatMode(config.mode),
  };
}

function getOpenRouterModelLabel(model: string): string {
  return AVAILABLE_OPENROUTER_MODELS.find((option) => option.value === model)?.label ?? model;
}

function normalizeSeatMode(mode: SpectatorSeatConfig['mode'] | 'builtin' | 'builtin-strong'): SeatAgentMode {
  if (mode === 'builtin' || mode === 'builtin-strong' || mode === 'builtin-legacy-v1' || mode === 'builtin-legacy-vR' || mode === 'builtin-baseline' || mode === 'builtin-balanced-v2' || mode === 'llmreranker') {
    return 'builtin-legacy-v3';
  }

  return mode;
}

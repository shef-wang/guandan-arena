import { useEffect, useState } from 'react';
import type { Seat } from '../game/types';
import type { SpectatorArenaConfig, SpectatorGlobalConfig, SpectatorSeatConfig, SpectatorSeatConfigMap, SeatAgentMode } from './spectatorConfig';
import { getSeatTitle, persistSpectatorConfig, validateSpectatorConfig } from './spectatorConfig';
import { OPENROUTER_DEFAULT_RERANKER_MODEL } from './openrouter';

const DEEPSEEK_V3_MODEL = 'deepseek/deepseek-chat-v3-0324';
const KIMI_K25_MODEL = 'moonshotai/kimi-k2.5';
const GEMMA_4_MODEL = 'google/gemma-4-26b-a4b-it';

type SeatStrategyId =
  | 'legacy-v1'
  | 'legacy-vR'
  | 'llmreranker-deepseek'
  | 'deepseek-v3'
  | 'kimi-k2.5'
  | 'gemma-4-26b';

interface SeatStrategyOption {
  id: SeatStrategyId;
  label: string;
  mode: SeatAgentMode;
  model: string;
  note: string;
  usesRemoteModel: boolean;
}

const SEAT_STRATEGY_OPTIONS: SeatStrategyOption[] = [
  {
    id: 'legacy-v1',
    label: 'guandan-ai v1 legacy',
    mode: 'builtin-legacy-v1',
    model: '',
    note: '本地 heuristic，不请求外部模型。',
    usesRemoteModel: false,
  },
  {
    id: 'legacy-vR',
    label: 'guandan-ai vR',
    mode: 'builtin-legacy-vR',
    model: '',
    note: '基于 legacy-v1 的 top-5 加权抽样，保留一定变化但可复现。',
    usesRemoteModel: false,
  },
  {
    id: 'llmreranker-deepseek',
    label: 'LLM Reranker · DeepSeek Chat V3 0324',
    mode: 'llmreranker',
    model: OPENROUTER_DEFAULT_RERANKER_MODEL,
    note: '先用 legacy-v1 产生候选，再用 DeepSeek V3 做重排。',
    usesRemoteModel: true,
  },
  {
    id: 'deepseek-v3',
    label: 'DeepSeek Chat V3 0324',
    mode: 'openrouter',
    model: DEEPSEEK_V3_MODEL,
    note: '直接用 DeepSeek V3 出牌。',
    usesRemoteModel: true,
  },
  {
    id: 'kimi-k2.5',
    label: 'Kimi K2.5',
    mode: 'openrouter',
    model: KIMI_K25_MODEL,
    note: '直接用 Kimi K2.5 出牌。',
    usesRemoteModel: true,
  },
  {
    id: 'gemma-4-26b',
    label: 'Gemma 4 26B A4B Instruct',
    mode: 'openrouter',
    model: GEMMA_4_MODEL,
    note: '直接用 Gemma 4 26B A4B Instruct 出牌。',
    usesRemoteModel: true,
  },
];

export default function ArenaSetupScreen({
  initialConfig,
  onBack,
  onStart,
}: {
  initialConfig: SpectatorArenaConfig;
  onBack: () => void;
  onStart: (config: SpectatorArenaConfig) => void;
}) {
  const [globalConfig, setGlobalConfig] = useState<SpectatorGlobalConfig>(initialConfig.globalConfig);
  const [seatConfigs, setSeatConfigs] = useState<SpectatorSeatConfigMap>(() => normalizeSeatConfigMap(initialConfig.seatConfigs));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGlobalConfig(initialConfig.globalConfig);
    setSeatConfigs(normalizeSeatConfigMap(initialConfig.seatConfigs));
  }, [initialConfig]);

  useEffect(() => {
    persistSpectatorConfig({
      globalConfig,
      seatConfigs,
    });
  }, [globalConfig, seatConfigs]);

  function handleGlobalChange<K extends keyof SpectatorGlobalConfig>(key: K, value: SpectatorGlobalConfig[K]): void {
    setGlobalConfig((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function handleSeatConfigChange<K extends keyof SpectatorSeatConfig>(seat: Seat, key: K, value: SpectatorSeatConfig[K]): void {
    setSeatConfigs((current) => ({
      ...current,
      [seat]: {
        ...current[seat],
        [key]: value,
      },
    }));
  }

  function handleSeatStrategyChange(seat: Seat, strategyId: SeatStrategyId): void {
    const option = getSeatStrategyOption(strategyId);
    setSeatConfigs((current) => ({
      ...current,
      [seat]: {
        ...current[seat],
        mode: option.mode,
        model: option.model,
        label: '',
      },
    }));
  }

  function handleStart(): void {
    const nextConfig = {
      globalConfig,
      seatConfigs,
    };
    const validationError = validateSpectatorConfig(nextConfig);

    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    onStart(nextConfig);
  }

  return (
    <section className="arena-setup-shell">
      <div className="arena-setup-header">
        <div className="app-title-group">
          <span className="eyebrow">4AI Arena Setup</span>
          <h1>先配置 4 个 seat，再进入观战台</h1>
        </div>

        <button className="ghost-button app-back-button" onClick={onBack} type="button">
          返回模式选择
        </button>
      </div>

      <section className="arena-panel arena-setup-panel">
        <div className="arena-panel-header">
          <div>
            <span className="label">4AI 阵容配置</span>
            <strong>只保留 URL、API key 和每个 seat 的策略选择</strong>
          </div>
        </div>

        <p className="arena-config-note">
          每个 seat 只选一个策略。`legacy` 走本地规则引擎，其他选项走 OpenRouter；seat key 留空时自动复用全局 key。
        </p>

        <div className="arena-global-config">
          <label className="arena-field wide">
            <span className="label">Base URL</span>
            <input
              className="arena-text-input"
              onChange={(event) => handleGlobalChange('baseUrl', event.target.value)}
              type="text"
              value={globalConfig.baseUrl}
            />
          </label>

          <label className="arena-field">
            <span className="label">全局 API Key</span>
            <input
              autoComplete="off"
              className="arena-text-input"
              onChange={(event) => handleGlobalChange('apiKey', event.target.value)}
              placeholder="sk-or-v1-..."
              type="password"
              value={globalConfig.apiKey}
            />
          </label>
        </div>

        {error ? <div className="arena-form-error">{error}</div> : null}

        <div className="arena-roster-grid">
          {([0, 1, 2, 3] as const).map((seat) => {
            const selectedStrategy = getSeatStrategyOption(getSelectedSeatStrategyId(seatConfigs[seat]));

            return (
              <section className="arena-select-card arena-seat-strategy-card" key={seat}>
                <div className="arena-seat-strategy-header">
                  <div>
                    <span className="eyebrow">
                      Seat {seat} · {getSeatTitle(seat)}
                    </span>
                    <strong>{seatName(seat)}</strong>
                  </div>
                  <span className={`arena-seat-strategy-pill ${selectedStrategy.usesRemoteModel ? 'remote' : 'local'}`}>
                    {selectedStrategy.usesRemoteModel ? 'LLM' : 'Local'}
                  </span>
                </div>

                <label className="arena-field">
                  <span className="label">策略 / 模型</span>
                  <select
                    className="arena-text-input"
                    onChange={(event) => handleSeatStrategyChange(seat, event.target.value as SeatStrategyId)}
                    value={getSelectedSeatStrategyId(seatConfigs[seat])}
                  >
                    {SEAT_STRATEGY_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="arena-field">
                  <span className="label">Seat Key 覆盖</span>
                  <input
                    autoComplete="off"
                    className="arena-text-input"
                    disabled={!selectedStrategy.usesRemoteModel}
                    onChange={(event) => handleSeatConfigChange(seat, 'apiKey', event.target.value)}
                    placeholder={selectedStrategy.usesRemoteModel ? '留空则使用全局 key' : 'legacy 不需要 key'}
                    type="password"
                    value={seatConfigs[seat].apiKey}
                  />
                </label>

                <p className="arena-config-note">{selectedStrategy.note}</p>
              </section>
            );
          })}
        </div>

        <div className="arena-setup-actions">
          <button className="primary-button arena-inline-button" onClick={handleStart} type="button">
            进入 4AI 观战台
          </button>
        </div>
      </section>
    </section>
  );
}

function seatName(seat: Seat): string {
  if (seat === 0) {
    return '你';
  }

  if (seat === 1) {
    return '右侧 AI';
  }

  if (seat === 2) {
    return '队友 AI';
  }

  return '左侧 AI';
}

function getSelectedSeatStrategyId(config: SpectatorSeatConfig): SeatStrategyId {
  if (config.mode === 'llmreranker') {
    return 'llmreranker-deepseek';
  }

  if (config.mode === 'builtin-legacy-vR') {
    return 'legacy-vR';
  }

  if (config.mode === 'openrouter') {
    if (config.model === KIMI_K25_MODEL) {
      return 'kimi-k2.5';
    }

    if (config.model === GEMMA_4_MODEL) {
      return 'gemma-4-26b';
    }

    return 'deepseek-v3';
  }

  return 'legacy-v1';
}

function getSeatStrategyOption(id: SeatStrategyId): SeatStrategyOption {
  return SEAT_STRATEGY_OPTIONS.find((option) => option.id === id) ?? SEAT_STRATEGY_OPTIONS[0];
}

function normalizeSeatConfigMap(config: SpectatorSeatConfigMap): SpectatorSeatConfigMap {
  return {
    0: normalizeSetupSeatConfig(config[0]),
    1: normalizeSetupSeatConfig(config[1]),
    2: normalizeSetupSeatConfig(config[2]),
    3: normalizeSetupSeatConfig(config[3]),
  };
}

function normalizeSetupSeatConfig(config: SpectatorSeatConfig): SpectatorSeatConfig {
  const option = getSeatStrategyOption(getSelectedSeatStrategyId(config));
  return {
    ...config,
    mode: option.mode,
    model: option.model,
    label: '',
  };
}

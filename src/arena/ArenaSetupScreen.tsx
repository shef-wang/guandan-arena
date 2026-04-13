import { useEffect, useState } from 'react';
import type { Seat } from '../game/types';
import type { SpectatorArenaConfig, SpectatorGlobalConfig, SpectatorSeatConfig, SpectatorSeatConfigMap, SeatAgentMode } from './spectatorConfig';
import { AVAILABLE_OPENROUTER_MODELS, getSeatTitle, persistSpectatorConfig, validateSpectatorConfig } from './spectatorConfig';

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
  const [seatConfigs, setSeatConfigs] = useState<SpectatorSeatConfigMap>(initialConfig.seatConfigs);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGlobalConfig(initialConfig.globalConfig);
    setSeatConfigs(initialConfig.seatConfigs);
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

  function handleSeatConfigChange<K extends keyof SpectatorSeatConfig>(
    seat: Seat,
    key: K,
    value: SpectatorSeatConfig[K],
  ): void {
    setSeatConfigs((current) => ({
      ...current,
      [seat]: {
        ...current[seat],
        [key]: value,
      },
    }));
  }

  function handleFillAllOpenRouter(): void {
    setSeatConfigs((current) => ({
      0: { ...current[0], mode: 'openrouter', label: 'Seat 0 LLM' },
      1: { ...current[1], mode: 'openrouter', label: 'Seat 1 LLM' },
      2: { ...current[2], mode: 'openrouter', label: 'Seat 2 LLM' },
      3: { ...current[3], mode: 'openrouter', label: 'Seat 3 LLM' },
    }));
  }

  function handleSetBuiltinPreset(mode: Extract<SeatAgentMode, 'builtin-balanced-v2' | 'builtin-legacy-v1'>): void {
    setSeatConfigs({
      0: createBuiltinSeatConfig(0, mode),
      1: createBuiltinSeatConfig(1, mode),
      2: createBuiltinSeatConfig(2, mode),
      3: createBuiltinSeatConfig(3, mode),
    });
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
            <strong>可以混搭 guandan-ai v2 balanced、v1 legacy、baseline 和 OpenRouter</strong>
          </div>
        </div>

        <p className="arena-config-note">
          进入 4AI 观战台后，会直接展示 4 个 player 的手牌和最近出牌，方便对比不同 seat 的策略表现。
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

        <div className="arena-panel-actions">
          <button className="ghost-button small" onClick={() => handleSetBuiltinPreset('builtin-balanced-v2')} type="button">
            4 个 seat 都切到 v2 balanced
          </button>
          <button className="ghost-button small" onClick={() => handleSetBuiltinPreset('builtin-legacy-v1')} type="button">
            4 个 seat 都切到 v1 legacy
          </button>
          <button className="ghost-button small" onClick={handleFillAllOpenRouter} type="button">
            4 个 seat 都切到 OpenRouter
          </button>
          <button className="primary-button arena-inline-button" onClick={handleStart} type="button">
            进入 4AI 观战台
          </button>
        </div>

        {error ? <div className="arena-form-error">{error}</div> : null}

        <div className="arena-roster-grid">
          {([0, 1, 2, 3] as const).map((seat) => (
            <section className="arena-select-card" key={seat}>
              <span className="eyebrow">
                Seat {seat} · {getSeatTitle(seat)}
              </span>
              <strong>{seatName(seat)}</strong>

              <label className="arena-field">
                <span className="label">模式</span>
                <select
                  className="arena-text-input"
                  onChange={(event) => handleSeatConfigChange(seat, 'mode', event.target.value as SeatAgentMode)}
                  value={seatConfigs[seat].mode}
                >
                  <option value="builtin-balanced-v2">guandan-ai v2 balanced</option>
                  <option value="builtin-legacy-v1">guandan-ai v1 legacy</option>
                  <option value="builtin-baseline">基础内置 heuristic</option>
                  <option value="openrouter">OpenRouter LLM</option>
                </select>
              </label>

              <label className="arena-field">
                <span className="label">显示名</span>
                <input
                  className="arena-text-input"
                  onChange={(event) => handleSeatConfigChange(seat, 'label', event.target.value)}
                  type="text"
                  value={seatConfigs[seat].label}
                />
              </label>

              {seatConfigs[seat].mode === 'openrouter' ? (
                <>
                  <label className="arena-field">
                    <span className="label">Model</span>
                    <select
                      className="arena-text-input"
                      onChange={(event) => handleSeatConfigChange(seat, 'model', event.target.value)}
                      value={seatConfigs[seat].model}
                    >
                      <option value="">选择已验证可用的模型</option>
                      {AVAILABLE_OPENROUTER_MODELS.map((model) => (
                        <option key={model.value} value={model.value}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="arena-field">
                    <span className="label">Seat Key 覆盖</span>
                    <input
                      autoComplete="off"
                      className="arena-text-input"
                      onChange={(event) => handleSeatConfigChange(seat, 'apiKey', event.target.value)}
                      placeholder="留空则使用全局 key"
                      type="password"
                      value={seatConfigs[seat].apiKey}
                    />
                  </label>
                </>
              ) : (
                <p className="arena-config-note">
                  当前 seat 使用
                  {seatConfigs[seat].mode === 'builtin-balanced-v2'
                    ? 'guandan-ai v2 balanced'
                    : seatConfigs[seat].mode === 'builtin-legacy-v1'
                      ? 'guandan-ai v1 legacy'
                      : '基础内置 heuristic'}
                  ，不会请求外部模型。
                </p>
              )}
            </section>
          ))}
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

function createBuiltinSeatConfig(
  seat: Seat,
  mode: Extract<SeatAgentMode, 'builtin-balanced-v2' | 'builtin-legacy-v1'>,
): SpectatorSeatConfig {
  return {
    mode,
    label: mode === 'builtin-balanced-v2' ? `Seat ${seat} Balanced` : `Seat ${seat} Legacy`,
    model: '',
    apiKey: '',
  };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { chooseAiAction } from './game/ai';
import { enumerateExactPlays, filterLegalPlays, getPlayDisplayRank, sortPlayOptionsForContext } from './game/rules';
import { applyPass, applyPlay, createNewGame, getSeatStatus } from './game/state';
import type { Card, GameState, PlayerState, Suit } from './game/types';
import GameTableScene from './table/GameTableScene';
import { PlayingCard, formatPlacementKey } from './ui/tableWidgets';
import { applyArenaChosenAction, buildArenaTurnInput } from './arena/engine';
import { createOpenRouterAgent } from './arena/openrouter';
import type { ArenaChosenAction } from './arena/types';
import { buildHeuristicContext, encodeTurnForPolicy } from '../training/scorenet/feature_codec';

type PracticeAiMode = 'legacy' | 'openrouter' | 'ppo';

interface ScoreNetStatus {
  available: boolean;
  checkpoint: string | null;
  error?: string;
}

interface ScoreNetChoiceResponse {
  chosen_index?: number;
  checkpoint?: string;
  error?: string;
}

interface OpenRouterLocalKeyResponse {
  available: boolean;
  key: string | null;
  source: string | null;
}

interface LegacyAiWorkerRequest {
  id: number;
  state: GameState;
  seat: 1 | 2 | 3;
  profile: typeof PRACTICE_LEGACY_PROFILE;
}

interface LegacyAiWorkerResponse {
  id: number;
  decision: ReturnType<typeof chooseAiAction>;
}

const HY3_MODEL = 'tencent/hy3-preview:free';
const PRACTICE_OPENROUTER_KEY_STORAGE = 'guandan-practice-openrouter-key';
const PRACTICE_LEGACY_PROFILE = 'legacy-v3.0' as const;

export default function PracticeTable() {
  const [gameStarted, setGameStarted] = useState(false);
  const [game, setGame] = useState<GameState>(() => createNewGame());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [organizedGroups, setOrganizedGroups] = useState<string[][]>([]);
  const [aiMode, setAiMode] = useState<PracticeAiMode>('legacy');
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [llmStatus, setLlmStatus] = useState('未启用');
  const [localKeySource, setLocalKeySource] = useState<string | null>(null);
  const [scoreNetStatus, setScoreNetStatus] = useState<ScoreNetStatus>({
    available: false,
    checkpoint: null,
  });
  const [scoreNetStatusText, setScoreNetStatusText] = useState('Checking latest PPO checkpoint...');
  const legacyWorkerRef = useRef<Worker | null>(null);
  const legacyWorkerPendingRef = useRef(
    new Map<number, { resolve: (decision: ReturnType<typeof chooseAiAction>) => void; reject: (error: Error) => void }>(),
  );
  const legacyWorkerRequestIdRef = useRef(1);

  const human = game.players[0];
  const normalizedOrganizedGroups = useMemo(() => normalizeOrganizedGroups(organizedGroups, human.hand), [organizedGroups, human.hand]);
  const humanGroups = buildDisplayGroups(human.hand, organizedGroups);
  const straightFlushHints = getStraightFlushHints(human.hand);
  const currentTarget = game.tablePlay?.play ?? null;
  const selectedCards = human.hand.filter((card) => selectedIds.includes(card.id));
  const selectedCardIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedOrganizedGroup = useMemo(
    () =>
      normalizedOrganizedGroups.find(
        (group) => group.length === selectedIds.length && group.every((id) => selectedCardIdSet.has(id)),
      ) ?? null,
    [normalizedOrganizedGroups, selectedCardIdSet, selectedIds.length],
  );
  const selectedPlayOptions = sortPlayOptionsForContext(
    filterLegalPlays(enumerateExactPlays(selectedCards), currentTarget),
    currentTarget,
  );
  const chosenPlay = selectedPlayOptions[selectedOptionIndex] ?? null;

  useEffect(() => {
    setSelectedOptionIndex(0);
  }, [selectedIds.join('|'), currentTarget?.key ?? 'lead']);

  useEffect(() => {
    if (game.currentPlayer !== 0 || game.winnerTeam !== null) {
      setSelectedIds([]);
    }
  }, [game.currentPlayer, game.winnerTeam]);

  useEffect(() => {
    if (selectedIds.length === 0) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('[data-keep-selection="true"]')) {
        return;
      }

      setSelectedIds([]);
      setSelectedOptionIndex(0);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [selectedIds.length]);

  useEffect(() => {
    setOrganizedGroups((current) => normalizeOrganizedGroups(current, human.hand));
  }, [human.hand]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const saved = window.localStorage.getItem(PRACTICE_OPENROUTER_KEY_STORAGE);
    if (saved) {
      setOpenRouterApiKey(saved);
    }

    void loadLocalOpenRouterKey(saved ?? '');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (openRouterApiKey.trim()) {
      window.localStorage.setItem(PRACTICE_OPENROUTER_KEY_STORAGE, openRouterApiKey.trim());
    } else {
      window.localStorage.removeItem(PRACTICE_OPENROUTER_KEY_STORAGE);
    }
  }, [openRouterApiKey]);

  useEffect(() => {
    void refreshScoreNetStatus();
  }, []);

  const hasOpenRouterKey = openRouterApiKey.trim().length > 0;
  const aiModeLabel =
    aiMode === 'openrouter' ? 'OpenRouter / HY3' : aiMode === 'ppo' ? 'Latest PPO ScoreNet' : '内置 legacy-v3.0';

  const openRouterSeatAgent = useMemo(() => {
    if (!hasOpenRouterKey) {
      return null;
    }

    return createOpenRouterAgent({
      id: 'practice-openrouter-agent',
      label: 'Practice HY3',
      apiKey: openRouterApiKey.trim(),
      model: HY3_MODEL,
      siteName: 'Guandan Practice',
      siteUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
      onStatus(event) {
        setLlmStatus((current) => {
          const next = formatOpenRouterStatus(event.code);
          return current === next ? current : next;
        });
      },
      timeoutMs: 20000,
      maxTokens: 120,
      temperature: 0.1,
    });
  }, [hasOpenRouterKey, openRouterApiKey]);

  useEffect(() => {
    if (game.winnerTeam !== null || game.currentPlayer === 0) {
      return undefined;
    }

    const actingSeat = game.currentPlayer;
    const delay = 700 + Math.floor(Math.random() * 500);
    const timer = window.setTimeout(() => {
      void runAiTurn(actingSeat as 1 | 2 | 3);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [game, aiMode, openRouterSeatAgent, scoreNetStatus.checkpoint]);

  useEffect(() => {
    if (typeof Worker === 'undefined') {
      return undefined;
    }

    const worker = new Worker(new URL('./workers/legacyAiWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<LegacyAiWorkerResponse>) => {
      const pending = legacyWorkerPendingRef.current.get(event.data.id);
      if (!pending) {
        return;
      }
      legacyWorkerPendingRef.current.delete(event.data.id);
      pending.resolve(event.data.decision);
    };
    worker.onerror = (event: ErrorEvent) => {
      const error = new Error(event.message || 'Legacy AI worker failed');
      for (const pending of legacyWorkerPendingRef.current.values()) {
        pending.reject(error);
      }
      legacyWorkerPendingRef.current.clear();
      legacyWorkerRef.current = null;
    };
    legacyWorkerRef.current = worker;

    return () => {
      for (const pending of legacyWorkerPendingRef.current.values()) {
        pending.reject(new Error('Legacy AI worker terminated'));
      }
      legacyWorkerPendingRef.current.clear();
      worker.terminate();
      legacyWorkerRef.current = null;
    };
  }, []);

  function chooseLegacyDecision(state: GameState, actingSeat: 1 | 2 | 3): Promise<ReturnType<typeof chooseAiAction>> {
    const worker = legacyWorkerRef.current;
    if (!worker) {
      return Promise.resolve(chooseAiAction(state, actingSeat, PRACTICE_LEGACY_PROFILE));
    }

    const id = legacyWorkerRequestIdRef.current;
    legacyWorkerRequestIdRef.current += 1;
    const request: LegacyAiWorkerRequest = {
      id,
      state,
      seat: actingSeat,
      profile: PRACTICE_LEGACY_PROFILE,
    };

    return new Promise((resolve, reject) => {
      legacyWorkerPendingRef.current.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  async function refreshScoreNetStatus(): Promise<void> {
    try {
      const response = await fetch('/api/scorenet/status');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const status = (await response.json()) as ScoreNetStatus;
      setScoreNetStatus(status);
      setScoreNetStatusText(
        status.available && status.checkpoint ? `Ready: ${formatCheckpointLabel(status.checkpoint)}` : 'No PPO checkpoint found.',
      );
    } catch (error) {
      setScoreNetStatus({ available: false, checkpoint: null });
      setScoreNetStatusText(`Unavailable: ${error instanceof Error ? error.message : 'ScoreNet endpoint failed'}`);
    }
  }

  async function loadLocalOpenRouterKey(existingKey: string): Promise<void> {
    if (existingKey.trim()) {
      return;
    }

    try {
      const response = await fetch('/api/openrouter/local-key');
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as OpenRouterLocalKeyResponse;
      if (!payload.available || !payload.key) {
        return;
      }

      setOpenRouterApiKey(payload.key);
      setLocalKeySource(payload.source);
      setLlmStatus(payload.source ? `已从本地 key 文件加载：${payload.source}` : '已从本地 key 文件加载');
    } catch {
      // Keep manual input flow when local key loading is unavailable.
    }
  }

  async function runAiTurn(actingSeat: 1 | 2 | 3): Promise<void> {
    if (aiMode === 'openrouter' && openRouterSeatAgent) {
      try {
        const input = buildArenaTurnInput(game, actingSeat);
        const action = await openRouterSeatAgent.decideTurn(input, {
          seat: actingSeat,
          state: game,
        });

        setGame((current) => {
          if (current.winnerTeam !== null || current.currentPlayer !== actingSeat) {
            return current;
          }

          return applyArenaChosenAction(current, actingSeat, action);
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'OpenRouter request failed';
        setLlmStatus(`fallback: ${message}`);
      }
    }

    if (aiMode === 'ppo') {
      try {
        const input = buildArenaTurnInput(game, actingSeat);
        const heuristic = buildHeuristicContext(game, actingSeat);
        const encoded = encodeTurnForPolicy(input, heuristic);
        const response = await fetch('/api/scorenet/choose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            checkpoint: scoreNetStatus.checkpoint,
            stateFeatures: encoded.stateFeatures,
            actionFeatures: encoded.actionFeatures,
          }),
        });
        const choice = (await response.json()) as ScoreNetChoiceResponse;
        if (!response.ok || choice.error) {
          throw new Error(choice.error ?? `HTTP ${response.status}`);
        }

        const chosenIndex = Math.max(0, Math.min(choice.chosen_index ?? 0, input.legalActions.length - 1));
        const chosen = input.legalActions[chosenIndex] ?? input.legalActions[0];
        if (!chosen) {
          throw new Error('PPO returned no legal action.');
        }

        const action: ArenaChosenAction = chosen.kind === 'pass' ? { kind: 'pass' } : { kind: 'play', actionId: chosen.actionId };
        setGame((current) => {
          if (current.winnerTeam !== null || current.currentPlayer !== actingSeat) {
            return current;
          }

          return applyArenaChosenAction(current, actingSeat, action);
        });
        setLlmStatus(`ppo: ${formatCheckpointLabel(choice.checkpoint ?? scoreNetStatus.checkpoint ?? '')}`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ScoreNet request failed';
        setLlmStatus(`ppo fallback: ${message}`);
      }
    }

    let decision: ReturnType<typeof chooseAiAction>;
    try {
      decision = await chooseLegacyDecision(game, actingSeat);
    } catch {
      decision = chooseAiAction(game, actingSeat, PRACTICE_LEGACY_PROFILE);
    }
    setGame((current) => {
      if (current.winnerTeam !== null || current.currentPlayer !== actingSeat) {
        return current;
      }

      if (decision.type === 'play' && decision.play) {
        return applyPlay(current, actingSeat, decision.play);
      }

      return applyPass(current, actingSeat);
    });
  }

  const humanTurn = game.currentPlayer === 0 && game.winnerTeam === null;
  const canPass = humanTurn && game.tablePlay !== null;
  const canPlay = humanTurn && chosenPlay !== null;
  const canOrganize = humanTurn && selectedIds.length >= 2 && selectedOrganizedGroup === null;
  const canRestoreSelected = humanTurn && selectedOrganizedGroup !== null;
  const canRestoreAll = humanTurn && selectedIds.length === 0 && normalizedOrganizedGroups.length > 0;
  const canRestore = canRestoreSelected || canRestoreAll;
  const showOrganizeAction = canOrganize;
  const showRestoreAction = !showOrganizeAction && canRestore;
  const organizeButtonLabel = showOrganizeAction ? '理牌' : '恢复';

  function handleToggleCard(card: Card, group?: Card[], indexInGroup?: number): void {
    if (!humanTurn) {
      return;
    }

    setSelectedIds((current) => {
      if (group && group.length > 1 && indexInGroup === 0) {
        const groupIds = group.map((groupCard) => groupCard.id);
        const allSelected = groupIds.every((id) => current.includes(id));

        if (allSelected) {
          return current.filter((id) => !groupIds.includes(id));
        }

        const merged = new Set([...current, ...groupIds]);
        return [...merged];
      }

      return current.includes(card.id) ? current.filter((id) => id !== card.id) : [...current, card.id];
    });
  }

  function handlePlay(): void {
    if (!canPlay || !chosenPlay) {
      return;
    }

    setGame((current) => applyPlay(current, 0, chosenPlay));
    setSelectedIds([]);
    setSelectedOptionIndex(0);
  }

  function handlePassTurn(): void {
    if (!canPass) {
      return;
    }

    setGame((current) => applyPass(current, 0));
    setSelectedIds([]);
    setSelectedOptionIndex(0);
  }

  function handleNewGame(): void {
    setGame(createNewGame());
    setSelectedIds([]);
    setSelectedOptionIndex(0);
    setOrganizedGroups([]);
  }

  function handleStartGame(): void {
    handleNewGame();
    setGameStarted(true);
  }

  function handleOrganize(): void {
    if (!canOrganize) {
      return;
    }

    const selectedSet = new Set(selectedIds);
    const orderedSelection = human.hand.filter((card) => selectedSet.has(card.id)).map((card) => card.id);

    setOrganizedGroups((current) => {
      const stripped = current
        .map((group) => group.filter((id) => !selectedSet.has(id)))
        .filter((group) => group.length > 1);
      return [...stripped, orderedSelection];
    });
  }

  function handleRestoreSelected(): void {
    if (!selectedOrganizedGroup) {
      return;
    }

    setOrganizedGroups((current) => {
      const target = new Set(selectedOrganizedGroup);
      return current
        .map((group) => group.filter((id) => !target.has(id)))
        .filter((group) => group.length > 1);
    });
    setSelectedIds([]);
    setSelectedOptionIndex(0);
  }

  function handleRestoreAll(): void {
    if (!canRestoreAll) {
      return;
    }

    setOrganizedGroups([]);
  }

  if (!gameStarted) {
    return (
      <PracticeSetupScreen
        aiMode={aiMode}
        canStart={aiMode === 'openrouter' ? hasOpenRouterKey : aiMode === 'ppo' ? scoreNetStatus.available : true}
        hasOpenRouterKey={hasOpenRouterKey}
        onAiModeChange={setAiMode}
        onOpenRouterApiKeyChange={setOpenRouterApiKey}
        onRefreshScoreNet={refreshScoreNetStatus}
        onStart={handleStartGame}
        openRouterApiKey={openRouterApiKey}
        scoreNetStatus={scoreNetStatus}
        scoreNetStatusText={scoreNetStatusText}
      />
    );
  }

  return (
    <GameTableScene
      game={game}
      showCenterPanel={false}
      insideStage={
        <section className="bottom-play-area">
          <div className="control-row">
            <button
              className="secondary-button game-action"
              data-keep-selection="true"
              disabled={!canPass}
              onClick={handlePassTurn}
              type="button"
            >
              不出
            </button>
            <button
              className="primary-button game-action play"
              data-keep-selection="true"
              disabled={!canPlay}
              onClick={handlePlay}
              type="button"
            >
              出牌
            </button>
          </div>

          <div className="bottom-tool-stack">
            <section className="straight-flush-hint-panel" aria-label="同花顺提示">
              <span className="straight-flush-hint-title">同花顺</span>
              <div className="straight-flush-hint-row">
                {straightFlushHints.map((hint) => (
                  <span
                    className={`straight-flush-suit-chip ${hint.active ? 'active' : ''} ${hint.tone}`}
                    key={hint.suit}
                    title={hint.active ? `${hint.name}可留意：${hint.windows.join(' / ')}` : `${hint.name}当前暂无明显机会`}
                  >
                    {hint.symbol}
                  </span>
                ))}
              </div>
            </section>

            <div className="arrange-controls">
              <button
                className="arrange-button restore"
                data-keep-selection="true"
                disabled={!showOrganizeAction && !showRestoreAction}
                onClick={showOrganizeAction ? handleOrganize : canRestoreSelected ? handleRestoreSelected : handleRestoreAll}
                type="button"
              >
                {organizeButtonLabel}
              </button>
              <button className="arrange-button one-click" data-keep-selection="true" disabled type="button">
                一键理牌
              </button>
            </div>
          </div>

          <section className="human-zone">
            <div className="human-headline">
              <div className="player-avatar seat-0">你</div>
              <div className="human-meta">
                <strong>你</strong>
                <span>{getSeatStatus(game, 0)}</span>
              </div>
              <div className="human-count">{human.hand.length} 张</div>
            </div>

            <div data-keep-selection="true">
              <HumanTrace player={human} game={game} />
            </div>

            <div className="hand-grid" data-keep-selection="true" role="list" aria-label="你的手牌">
              {humanGroups.map((group) => (
                <div className="hand-column" key={group.map((card) => card.id).join('|')}>
                  {group.map((card, index) => {
                    const selected = selectedIds.includes(card.id);
                    return (
                      <button
                        className={`stack-card-button ${selected ? 'selected' : ''}`}
                        key={card.id}
                        onClick={() => handleToggleCard(card, group, index)}
                        style={{
                          zIndex: group.length - index,
                          transform: `translateY(${-index * 36}px)`,
                        }}
                        type="button"
                      >
                        <PlayingCard card={card} grouped selected={selected} />
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        </section>
      }
      leftBadges={[
        { label: '模式', value: '单机练习' },
        { label: 'AI', value: aiModeLabel },
        { label: '主牌', value: 'A' },
      ]}
      onReset={handleNewGame}
      resetLabel="重新发牌"
      rightBadges={[
        { label: '结果', value: game.result ? game.result.badge : '进行中' },
      ]}
      seats={[
        { seat: 2, position: 'top' },
        { seat: 3, position: 'left' },
        { seat: 1, position: 'right' },
      ]}
      afterStage={
        <section className="table-hud">
          <div className="hud-item wide">
            <span className="label">当前状态</span>
            <strong>{game.message}</strong>
          </div>
          <div className="hud-item">
            <span className="label">桌面牌型</span>
            <strong>{currentTarget ? getPlayDisplayRank(currentTarget) : '等待领出'}</strong>
          </div>
          <div className="hud-item">
            <span className="label">你的选择</span>
            <strong>{chosenPlay ? chosenPlay.label : selectedCards.length > 0 ? '当前选牌不是合法牌型' : '尚未选牌'}</strong>
          </div>
          <div className="hud-item">
            <span className="label">{game.result ? '分列/结果' : '完成顺序'}</span>
            <strong>{game.result ? `${formatPlacementKey(game.result.placementKey)} · ${game.result.badge}` : renderFinishOrder(game)}</strong>
          </div>

          <div className="hud-item wide">
            <span className="label">AI 对战配置</span>
            <strong>{aiModeLabel}</strong>
            <div className="hud-inline-actions">
              <button
                className={`ghost-button hud-inline-button ${aiMode === 'legacy' ? 'active' : ''}`}
                onClick={() => setAiMode('legacy')}
                type="button"
              >
                内置 AI
              </button>
              <button
                className={`ghost-button hud-inline-button ${aiMode === 'openrouter' ? 'active' : ''}`}
                disabled={!hasOpenRouterKey}
                onClick={() => setAiMode('openrouter')}
                type="button"
              >
                HY3
              </button>
              <button
                className={`ghost-button hud-inline-button ${aiMode === 'ppo' ? 'active' : ''}`}
                disabled={!scoreNetStatus.available}
                onClick={() => setAiMode('ppo')}
                type="button"
              >
                Latest PPO
              </button>
            </div>
            <div className="hud-key-row">
              <input
                className="hud-key-input"
                onChange={(event) => setOpenRouterApiKey(event.target.value)}
                placeholder="sk-or-v1-...（HY3 使用的 OpenRouter key）"
                type="password"
                value={openRouterApiKey}
              />
            </div>
            {localKeySource ? <span className="label">Key source: {localKeySource}</span> : null}
            <span className="label">状态：{aiMode === 'legacy' ? '内置 AI' : aiMode === 'ppo' ? `${scoreNetStatusText} · ${llmStatus}` : llmStatus}</span>
            <button className="link-button hud-switch" onClick={() => setGameStarted(false)} type="button">
              配置新局
            </button>
          </div>

          {selectedPlayOptions.length > 1 ? (
            <button
              className="link-button hud-switch"
              data-keep-selection="true"
              onClick={() => setSelectedOptionIndex((current) => (current + 1) % selectedPlayOptions.length)}
              type="button"
            >
              切换牌型
            </button>
          ) : null}
        </section>
      }
    />
  );
}

function PracticeSetupScreen({
  aiMode,
  canStart,
  hasOpenRouterKey,
  onAiModeChange,
  onOpenRouterApiKeyChange,
  onRefreshScoreNet,
  onStart,
  openRouterApiKey,
  scoreNetStatus,
  scoreNetStatusText,
}: {
  aiMode: PracticeAiMode;
  canStart: boolean;
  hasOpenRouterKey: boolean;
  onAiModeChange: (mode: PracticeAiMode) => void;
  onOpenRouterApiKeyChange: (value: string) => void;
  onRefreshScoreNet: () => void;
  onStart: () => void;
  openRouterApiKey: string;
  scoreNetStatus: ScoreNetStatus;
  scoreNetStatusText: string;
}) {
  return (
    <section className="practice-setup-shell">
      <header className="arena-setup-header">
        <div>
          <span className="eyebrow">Single Player Setup</span>
          <h1>Choose Your Opponents</h1>
          <p className="muted-copy">Seat 0 is you. Seats 1, 2, and 3 will use the AI option selected below.</p>
        </div>
        <a className="ghost-button app-nav-link" href="/">
          Home
        </a>
      </header>

      <section className="arena-setup-panel practice-setup-panel">
        <div className="practice-ai-grid">
          <button
            className={`practice-ai-card ${aiMode === 'legacy' ? 'active' : ''}`}
            onClick={() => onAiModeChange('legacy')}
            type="button"
          >
            <span className="start-mode-kicker">Built-in</span>
            <strong>legacy-v3.0</strong>
            <p>Fast local heuristic AI. This is the default single-player opponent.</p>
          </button>

          <button
            className={`practice-ai-card ${aiMode === 'ppo' ? 'active' : ''}`}
            disabled={!scoreNetStatus.available}
            onClick={() => onAiModeChange('ppo')}
            type="button"
          >
            <span className="start-mode-kicker">Local PPO</span>
            <strong>Latest ScoreNet PPO</strong>
            <p>{scoreNetStatusText}</p>
          </button>

          <button
            className={`practice-ai-card ${aiMode === 'openrouter' ? 'active' : ''}`}
            disabled={!hasOpenRouterKey}
            onClick={() => onAiModeChange('openrouter')}
            type="button"
          >
            <span className="start-mode-kicker">BYOK</span>
            <strong>HY3</strong>
            <p>Uses local key file first, then manual OpenRouter key; falls back to legacy-v3.0 on errors.</p>
          </button>
        </div>

        <div className="practice-setup-controls">
          <label className="agent-form-field">
            <span>OpenRouter key for HY3 mode</span>
            <input
              onChange={(event) => onOpenRouterApiKeyChange(event.target.value)}
              placeholder="sk-or-v1-..."
              type="password"
              value={openRouterApiKey}
            />
          </label>

          <div className="practice-status-box">
            <span className="label">PPO endpoint</span>
            <strong>{scoreNetStatus.available ? 'Available' : 'Unavailable'}</strong>
            <p>{scoreNetStatus.checkpoint ? formatCheckpointLabel(scoreNetStatus.checkpoint) : scoreNetStatusText}</p>
            <button className="ghost-button small" onClick={onRefreshScoreNet} type="button">
              Refresh PPO
            </button>
          </div>
        </div>

        <div className="arena-setup-actions">
          <button className="primary-button" disabled={!canStart} onClick={onStart} type="button">
            Start Single Player Game
          </button>
          {!canStart ? <span className="muted-copy">Selected AI is not ready yet.</span> : null}
        </div>
      </section>
    </section>
  );
}

function HumanTrace({ player, game }: { player: PlayerState; game: GameState }) {
  const trace = game.roundTrace[player.seat];

  if (!trace.action) {
    return null;
  }

  return (
    <div className={`human-trace ${trace.play ? 'has-play' : 'pass'} flash-in`} key={`${player.seat}-${trace.action}`}>
      {trace.play ? (
        <>
          <span className="trace-label">你的本轮出牌：{trace.play.label}</span>
          <div className="trace-cards-row">
            {trace.play.cards.map((card) => (
              <PlayingCard card={card} compact key={`${player.seat}-${card.id}`} trace />
            ))}
          </div>
        </>
      ) : (
        <span className="trace-pass">你的本轮动作：不出</span>
      )}
    </div>
  );
}

function buildDisplayGroups(cards: Card[], organizedGroups: string[][]): Card[][] {
  const normalizedGroups = normalizeOrganizedGroups(organizedGroups, cards);
  const groupByCardId = new Map<string, Card[]>();

  for (const group of normalizedGroups) {
    const mappedGroup = group
      .map((id) => cards.find((card) => card.id === id))
      .filter((card): card is Card => Boolean(card));

    if (mappedGroup.length < 2) {
      continue;
    }

    for (const card of mappedGroup) {
      groupByCardId.set(card.id, mappedGroup);
    }
  }

  const groups: Card[][] = [];

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const organizedGroup = groupByCardId.get(card.id);

    if (organizedGroup) {
      if (organizedGroup[0].id === card.id) {
        groups.push(organizedGroup);
      }
      continue;
    }

    const nextGroup = [card];
    let cursor = index + 1;

    while (cursor < cards.length) {
      const nextCard = cards[cursor];
      if (groupByCardId.has(nextCard.id) || nextCard.rank !== card.rank) {
        break;
      }

      nextGroup.push(nextCard);
      cursor += 1;
    }

    groups.push(nextGroup);
    index = cursor - 1;
  }

  return groups;
}

function normalizeOrganizedGroups(groups: string[][], cards: Card[]): string[][] {
  const cardIds = new Set(cards.map((card) => card.id));

  return groups
    .map((group) => group.filter((id) => cardIds.has(id)))
    .filter((group) => group.length > 1)
    .map((group) => cards.filter((card) => group.includes(card.id)).map((card) => card.id));
}

function renderFinishOrder(game: GameState): string {
  if (game.finishOrder.length === 0) {
    return '暂无';
  }

  return game.finishOrder.map((seat) => game.players[seat].name).join(' / ');
}

function formatCheckpointLabel(checkpoint: string): string {
  if (!checkpoint) return 'Latest PPO checkpoint';
  const marker = 'training/scorenet/checkpoints/';
  const markerIndex = checkpoint.indexOf(marker);
  return markerIndex >= 0 ? checkpoint.slice(markerIndex + marker.length) : checkpoint;
}

function formatOpenRouterStatus(code: string): string {
  if (code === 'requesting') {
    return 'hy3: 请求中';
  }

  if (code === 'success') {
    return 'hy3: 已出牌';
  }

  if (code === 'request_error') {
    return 'hy3: 接口失败';
  }

  if (code === 'invalid_json') {
    return 'hy3: 返回格式异常';
  }

  if (code === 'repairing') {
    return 'hy3: 修复中';
  }

  if (code === 'repair_success') {
    return 'hy3: 修复成功';
  }

  if (code === 'fallback') {
    return 'hy3: 已回退到 legacy';
  }

  return 'hy3: 已跳过';
}

interface StraightFlushHint {
  suit: Suit;
  symbol: string;
  name: string;
  tone: 'red' | 'black';
  active: boolean;
  windows: string[];
}

const STRAIGHT_FLUSH_SUITS: Array<{ suit: Suit; symbol: string; name: string; tone: 'red' | 'black' }> = [
  { suit: 'hearts', symbol: '♥', name: '红桃', tone: 'red' },
  { suit: 'spades', symbol: '♠', name: '黑桃', tone: 'black' },
  { suit: 'clubs', symbol: '♣', name: '梅花', tone: 'black' },
  { suit: 'diamonds', symbol: '♦', name: '方块', tone: 'red' },
];

const STRAIGHT_FLUSH_WINDOWS = buildStraightFlushWindows();

function getStraightFlushHints(cards: Card[]): StraightFlushHint[] {
  const wildCount = cards.filter((card) => card.isWild).length;

  return STRAIGHT_FLUSH_SUITS.map(({ suit, symbol, name, tone }) => {
    const rankValues = new Set(
      cards
        .filter((card) => card.suit === suit && !card.isWild)
        .map((card) => rankToValue(card.rank))
        .filter((value): value is number => value !== null),
    );

    const windows = STRAIGHT_FLUSH_WINDOWS.filter((window) => {
      const presentCount = window.values.filter((value) => rankValues.has(value)).length;
      return presentCount + wildCount >= 5;
    }).map((window) => window.label);

    return {
      suit,
      symbol,
      name,
      tone,
      active: windows.length > 0,
      windows,
    };
  });
}

function buildStraightFlushWindows(): Array<{ values: number[]; label: string }> {
  const windows: Array<{ values: number[]; label: string }> = [{ values: [14, 2, 3, 4, 5], label: 'A-2-3-4-5' }];

  for (let start = 2; start <= 10; start += 1) {
    const values = Array.from({ length: 5 }, (_, index) => start + index);
    windows.push({
      values,
      label: values.map(valueToRankText).join('-'),
    });
  }

  return windows;
}

function rankToValue(rank: Card['rank']): number | null {
  switch (rank) {
    case '2':
      return 2;
    case '3':
      return 3;
    case '4':
      return 4;
    case '5':
      return 5;
    case '6':
      return 6;
    case '7':
      return 7;
    case '8':
      return 8;
    case '9':
      return 9;
    case '10':
      return 10;
    case 'J':
      return 11;
    case 'Q':
      return 12;
    case 'K':
      return 13;
    case 'A':
      return 14;
    default:
      return null;
  }
}

function valueToRankText(value: number): string {
  if (value === 11) {
    return 'J';
  }

  if (value === 12) {
    return 'Q';
  }

  if (value === 13) {
    return 'K';
  }

  if (value === 14) {
    return 'A';
  }

  return String(value);
}

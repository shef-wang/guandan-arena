import { useEffect, useRef, useState } from 'react';
import { getSeatStatus } from '../game/state';
import type { GameState, Seat } from '../game/types';
import GameTableScene from '../table/GameTableScene';
import { PlayingCard, formatPlacementKey } from '../ui/tableWidgets';
import { createHeuristicAgent, formatTurnInputAsPrompt, GuandanArenaMatch } from './index';
import { createOpenRouterAgent, OPENROUTER_DEFAULT_BASE_URL } from './openrouter';
import type { SpectatorArenaConfig, SpectatorGlobalConfig, SpectatorSeatConfig, SpectatorSeatConfigMap } from './spectatorConfig';
import { getSeatDisplayLabel, getSeatSubtitle, getSeatTitle, trimEndpoint } from './spectatorConfig';

const DEFAULT_DELAY_MS = 900;
const ARENA_SEATS = [0, 1, 2, 3] as const;

interface ArenaLogEntry {
  id: string;
  turn: number;
  seat: Seat;
  actor: string;
  agent: string;
  action: string;
  summary: string;
}

export default function ArenaSpectator({ config }: { config: SpectatorArenaConfig }) {
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [isStepping, setIsStepping] = useState(false);
  const [stepDelay, setStepDelay] = useState(DEFAULT_DELAY_MS);
  const [logs, setLogs] = useState<ArenaLogEntry[]>([]);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const matchRef = useRef<GuandanArenaMatch>(createSpectatorMatch(config));
  const [game, setGame] = useState<GameState>(() => matchRef.current.getState());

  const currentInput = game.result ? null : matchRef.current.getTurnInput();
  const inspectorHandGroups = currentInput ? buildInspectorHandGroups(currentInput.hand) : [];
  const promptPreview = currentInput ? formatTurnInputAsPrompt(currentInput) : '';
  const visibleHands = ARENA_SEATS.map((seat) => ({
    seat,
    player: game.players[seat],
    trace: game.roundTrace[seat],
    handGroups: buildInspectorHandGroups(game.players[seat].hand),
    active: game.currentPlayer === seat && !game.result,
  }));

  useEffect(() => {
    matchRef.current = createSpectatorMatch(config);
    setGame(matchRef.current.getState());
    setRuntimeError(null);
    setAutoRun(false);
    setLogs([]);
  }, [config]);

  useEffect(() => {
    if (game.result && autoRun) {
      setAutoRun(false);
    }
  }, [autoRun, game.result]);

  useEffect(() => {
    if (!autoRun || game.result || isStepping) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void handleStep();
    }, stepDelay);

    return () => window.clearTimeout(timer);
  }, [autoRun, game.currentPlayer, game.result, isStepping, stepDelay]);

  useEffect(() => {
    if (!copiedPrompt) {
      return undefined;
    }

    const timer = window.setTimeout(() => setCopiedPrompt(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copiedPrompt]);

  async function handleStep(): Promise<void> {
    if (isStepping || game.result) {
      return;
    }

    setIsStepping(true);

    try {
      const stepResult = await matchRef.current.step();
      const actingAgent = getSeatDisplayLabel(config.seatConfigs[stepResult.seat]);
      let actionLabel = '不出';

      if (stepResult.action.kind === 'play') {
        const actionId = stepResult.action.actionId;
        actionLabel = stepResult.input.legalActions.find((action) => action.actionId === actionId)?.label ?? actionId;
      }

      setRuntimeError(null);
      setGame(stepResult.nextState);
      appendLog({
        seat: stepResult.seat,
        actor: stepResult.nextState.players[stepResult.seat].name,
        agent: actingAgent,
        action: actionLabel,
        summary: stepResult.nextState.message,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const seat = game.currentPlayer;
      setRuntimeError(message);
      setAutoRun(false);
      appendLog({
        seat,
        actor: game.players[seat].name,
        agent: getSeatDisplayLabel(config.seatConfigs[seat]),
        action: '请求失败',
        summary: message,
      });
    } finally {
      setIsStepping(false);
    }
  }

  function appendLog(entry: Omit<ArenaLogEntry, 'id' | 'turn'>): void {
    setLogs((current) => [
      ...current,
      {
        ...entry,
        id: `${current.length + 1}-${entry.seat}-${Date.now()}`,
        turn: current.length + 1,
      },
    ]);
  }

  function handleToggleAutoRun(): void {
    if (game.result) {
      return;
    }

    setAutoRun((current) => !current);
  }

  function handleRestart(): void {
    matchRef.current = createSpectatorMatch(config);
    setGame(matchRef.current.getState());
    setRuntimeError(null);
    setAutoRun(false);
    setLogs([]);
  }

  async function handleCopyPrompt(): Promise<void> {
    if (!promptPreview) {
      return;
    }

    try {
      await navigator.clipboard.writeText(promptPreview);
      setCopiedPrompt(true);
    } catch {
      setCopiedPrompt(false);
    }
  }

  return (
    <GameTableScene
      centerPanel={{
        eyebrow: runtimeError ? '运行异常' : game.result ? '终局结果' : '当前状态',
        title: runtimeError
          ? runtimeError
          : game.result
            ? `${formatPlacementKey(game.result.placementKey)} · ${game.result.badge}`
            : game.message,
        note: runtimeError
          ? '返回配置页检查 seat 的 model / key。'
          : game.result
            ? '这一局已经结束，可以重新开始。'
            : isStepping
              ? '当前 seat 正在请求模型。'
              : '主页面现在只负责观战和运行。',
      }}
      game={game}
      stageClassName="arena-stage"
      insideStage={
        <section className="arena-control-rail">
          <button className="secondary-button arena-action" disabled={Boolean(game.result) || isStepping} onClick={() => void handleStep()} type="button">
            单步
          </button>
          <button className="primary-button arena-action play" disabled={Boolean(game.result) || isStepping} onClick={handleToggleAutoRun} type="button">
            {autoRun ? '暂停' : '自动运行'}
          </button>
          <button className="ghost-button arena-action" disabled={isStepping} onClick={handleRestart} type="button">
            再来一局
          </button>
        </section>
      }
      leftBadges={[
        { label: '模式', value: '4AI 观战' },
        { label: '主牌', value: 'A' },
      ]}
      onReset={handleRestart}
      resetLabel="再来一局"
      rightBadges={[
        { label: '当前轮到', value: game.result ? '对局结束' : game.players[game.currentPlayer].name },
        { label: '回合步数', value: String(logs.length) },
        { label: 'Endpoint', value: trimEndpoint(config.globalConfig.baseUrl) },
      ]}
      seats={[
        { seat: 2, position: 'top', subtitle: getSeatSubtitle(config.seatConfigs[2]), openHandCards: game.players[2].hand },
        { seat: 3, position: 'left', subtitle: getSeatSubtitle(config.seatConfigs[3]), openHandCards: game.players[3].hand },
        { seat: 1, position: 'right', subtitle: getSeatSubtitle(config.seatConfigs[1]), openHandCards: game.players[1].hand },
        { seat: 0, position: 'bottom', subtitle: getSeatSubtitle(config.seatConfigs[0]), openHandCards: game.players[0].hand },
      ]}
      afterStage={
        <section className="arena-dashboard">
          <section className="arena-panel arena-open-table-panel">
            <div className="arena-panel-header">
              <div>
                <span className="label">全桌明牌</span>
                <strong>4 个 player 的手牌和最近出牌都会在这里持续可见</strong>
              </div>
            </div>

            <div className="arena-open-table-grid">
              {visibleHands.map(({ seat, player, trace, handGroups, active }) => (
                <article className={`arena-open-seat-card ${active ? 'active' : ''}`} key={seat}>
                  <div className="arena-open-seat-header">
                    <div>
                      <span className="eyebrow">
                        Seat {seat} · {getSeatTitle(seat)}
                      </span>
                      <strong>{player.name}</strong>
                      <div className="arena-summary-model">{getSeatDisplayLabel(config.seatConfigs[seat])}</div>
                    </div>
                    <div className="arena-open-seat-pill">{player.finished ? `${game.finishOrder.indexOf(seat) + 1} 位离手` : `${player.hand.length} 张`}</div>
                  </div>

                  <div className="arena-open-seat-meta">
                    <div className="arena-stat-block">
                      <span className="label">状态</span>
                      <strong>{getSeatStatus(game, seat)}</strong>
                    </div>
                    <div className="arena-stat-block">
                      <span className="label">最近动作</span>
                      <strong>{getSeatRecentAction(game, seat)}</strong>
                    </div>
                  </div>

                  <div className="arena-open-seat-trace">
                    {trace.play ? (
                      <div className="trace-cards-row">
                        {trace.play.cards.map((card) => (
                          <PlayingCard card={card} compact key={`${seat}-trace-${card.id}`} trace />
                        ))}
                      </div>
                    ) : (
                      <span className="arena-open-seat-trace-text">
                        {trace.action ? trace.action : player.finished ? '这一家已经出完手牌。' : '这一家还没有新的出牌。'}
                      </span>
                    )}
                  </div>

                  {handGroups.length > 0 ? (
                    <div className="arena-hand-grid arena-open-seat-hand" role="list" aria-label={`${player.name} 的手牌`}>
                      {handGroups.map((group) => (
                        <div className="arena-hand-column" key={group.map((card) => card.id).join('|')}>
                          {group.map((card, index) => (
                            <div
                              className="arena-hand-card"
                              key={card.id}
                              style={{
                                zIndex: group.length - index,
                                transform: `translateY(${-index * 34}px)`,
                              }}
                            >
                              <PlayingCard card={card} grouped />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="arena-open-seat-hand-empty">这一家已经没有手牌。</div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="arena-panel">
            <div className="arena-panel-header">
              <div>
                <span className="label">当前阵容</span>
                <strong>这一局使用的 4 个 seat 配置</strong>
              </div>
            </div>

            <div className="arena-roster-summary">
              {ARENA_SEATS.map((seat) => (
                <article className="arena-summary-card" key={seat}>
                  <span className="eyebrow">
                    Seat {seat} · {getSeatTitle(seat)}
                  </span>
                  <strong>{game.players[seat].name}</strong>
                  <div>{getSeatDisplayLabel(config.seatConfigs[seat])}</div>
                  <div className="arena-summary-model">
                    {getSeatModeSummary(config.seatConfigs[seat])}
                  </div>
                </article>
              ))}
            </div>

            <div className="arena-speed-row">
              <label className="arena-speed-control">
                <span className="label">自动运行节奏</span>
                <input
                  max="1800"
                  min="250"
                  onChange={(event) => setStepDelay(Number(event.target.value))}
                  step="50"
                  type="range"
                  value={stepDelay}
                />
              </label>
              <strong>{stepDelay} ms / 步</strong>
            </div>
          </section>

          <section className="arena-panel arena-inspector-panel">
            <div className="arena-panel-header">
              <div>
                <span className="label">Turn Inspector</span>
                <strong>{currentInput ? `${currentInput.players[currentInput.currentPlayer].name} 的结构化输入` : '对局已结束'}</strong>
              </div>
              <button className="ghost-button small" disabled={!currentInput} onClick={() => void handleCopyPrompt()} type="button">
                {copiedPrompt ? '已复制 Prompt' : '复制 Prompt'}
              </button>
            </div>

            {currentInput ? (
              <>
                <div className="arena-inline-meta">
                  <div className="arena-stat-block">
                    <span className="label">当前目标</span>
                    <strong>{currentInput.currentTablePlay ? currentInput.currentTablePlay.play.label : '等待领出'}</strong>
                  </div>
                  <div className="arena-stat-block">
                    <span className="label">合法动作数</span>
                    <strong>{currentInput.legalActions.length}</strong>
                  </div>
                  <div className="arena-stat-block">
                    <span className="label">当前 agent</span>
                    <strong>{getSeatDisplayLabel(config.seatConfigs[currentInput.currentPlayer])}</strong>
                  </div>
                </div>

                <div className="arena-hand-grid" role="list" aria-label="当前行动 seat 的手牌">
                  {inspectorHandGroups.map((group) => (
                    <div className="arena-hand-column" key={group.map((card) => card.id).join('|')}>
                      {group.map((card, index) => (
                        <div
                          className="arena-hand-card"
                          key={card.id}
                          style={{
                            zIndex: group.length - index,
                            transform: `translateY(${-index * 34}px)`,
                          }}
                        >
                          <PlayingCard card={card} grouped />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                <div className="arena-legal-actions">
                  {currentInput.legalActions.map((action) => (
                    <div className={`arena-action-chip ${action.kind === 'pass' ? 'pass' : ''}`} key={action.actionId}>
                      <strong>{action.kind === 'pass' ? '不出' : action.label}</strong>
                      <span>{action.kind === 'pass' ? 'pass' : action.actionId}</span>
                    </div>
                  ))}
                </div>

                <pre className="arena-prompt-preview">{promptPreview}</pre>
              </>
            ) : (
              <div className="arena-empty">这一局已经结束。重新开始后这里会继续显示下一手的结构化输入。</div>
            )}
          </section>

          <section className="arena-panel arena-log-panel">
            <div className="arena-panel-header">
              <div>
                <span className="label">Action Log</span>
                <strong>逐手观战记录</strong>
              </div>
            </div>

            <div className="arena-log-list">
              {logs.length > 0 ? (
                logs
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <article className="arena-log-entry" key={entry.id}>
                      <div className="arena-log-topline">
                        <strong>
                          #{entry.turn} · {entry.actor}
                        </strong>
                        <span>{entry.agent}</span>
                      </div>
                      <div className="arena-log-action">{entry.action}</div>
                      <p>{entry.summary}</p>
                    </article>
                  ))
              ) : (
                <div className="arena-empty">还没有动作记录。点“单步”或“自动运行”开始观战。</div>
              )}
            </div>
          </section>
        </section>
      }
    />
  );
}

function createSpectatorMatch(config: SpectatorArenaConfig): GuandanArenaMatch {
  return new GuandanArenaMatch({
    agents: [
      resolveSeatAgent(config.seatConfigs[0], config.globalConfig, 0),
      resolveSeatAgent(config.seatConfigs[1], config.globalConfig, 1),
      resolveSeatAgent(config.seatConfigs[2], config.globalConfig, 2),
      resolveSeatAgent(config.seatConfigs[3], config.globalConfig, 3),
    ],
  });
}

function resolveSeatAgent(seatConfig: SpectatorSeatConfig, globalConfig: SpectatorGlobalConfig, seat: Seat) {
  if (seatConfig.mode === 'builtin-balanced-v2') {
    return createHeuristicAgent({
      id: `builtin-balanced-seat-${seat}`,
      label: seatConfig.label || `Seat ${seat} Balanced`,
      profile: 'balanced-v2',
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

  return createOpenRouterAgent({
    id: `openrouter-seat-${seat}`,
    label: seatConfig.label || `Seat ${seat} LLM`,
    apiKey: seatConfig.apiKey.trim() || globalConfig.apiKey.trim(),
    model: seatConfig.model.trim(),
    baseUrl: globalConfig.baseUrl.trim() || OPENROUTER_DEFAULT_BASE_URL,
    siteName: 'Guandan Arena',
    siteUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return '未知错误';
}

function getSeatModeSummary(config: SpectatorSeatConfig): string {
  if (config.mode === 'builtin-balanced-v2') {
    return 'guandan-ai v2 balanced';
  }

  if (config.mode === 'builtin-legacy-v1') {
    return 'guandan-ai v1 legacy';
  }

  if (config.mode === 'builtin-baseline') {
    return '基础内置 heuristic';
  }

  return config.model;
}

function getSeatRecentAction(game: GameState, seat: Seat): string {
  const trace = game.roundTrace[seat];

  if (trace.action) {
    return trace.action;
  }

  return game.lastActions[seat] || '等待首个动作';
}

function buildInspectorHandGroups<T extends { id: string; rank: string }>(cards: T[]): T[][] {
  const groups: T[][] = [];

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const nextGroup = [card];
    let cursor = index + 1;

    while (cursor < cards.length && cards[cursor].rank === card.rank) {
      nextGroup.push(cards[cursor]);
      cursor += 1;
    }

    groups.push(nextGroup);
    index = cursor - 1;
  }

  return groups;
}

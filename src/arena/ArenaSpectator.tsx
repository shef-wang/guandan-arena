import { useEffect, useRef, useState } from 'react';
import { getSeatStatus } from '../game/state';
import type { GameState, Seat } from '../game/types';
import GameTableScene from '../table/GameTableScene';
import { PlayingCard, formatPlacementKey } from '../ui/tableWidgets';
import { formatTurnInputAsPrompt, GuandanArenaMatch } from './index';
import {
  OPENROUTER_DEFAULT_RERANKER_MODEL,
  type OpenRouterStatusCode,
  type OpenRouterStatusEvent,
} from './openrouter';
import type { SpectatorArenaConfig, SpectatorSeatConfig } from './spectatorConfig';
import { getSeatDisplayLabel, getSeatSubtitle, getSeatTitle, trimEndpoint } from './spectatorConfig';
import { createSpectatorMatch } from './spectatorMatch';

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

interface ArenaLlmStatusEntry extends OpenRouterStatusEvent {
  id: string;
}

export default function ArenaSpectator({ config }: { config: SpectatorArenaConfig }) {
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [isStepping, setIsStepping] = useState(false);
  const [stepDelay, setStepDelay] = useState(DEFAULT_DELAY_MS);
  const [logs, setLogs] = useState<ArenaLogEntry[]>([]);
  const [llmStatusLog, setLlmStatusLog] = useState<ArenaLlmStatusEntry[]>([]);
  const [llmSeatStatus, setLlmSeatStatus] = useState<Partial<Record<Seat, ArenaLlmStatusEntry>>>({});
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const llmStatusSequenceRef = useRef(0);

  const matchRef = useRef<GuandanArenaMatch>(
    createSpectatorMatch(config, {
      onLlmStatus: appendLlmStatus,
      siteUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
    }),
  );
  const [game, setGame] = useState<GameState>(() => matchRef.current.getState());
  const remoteSeats = ARENA_SEATS.filter((seat) => usesRemoteModel(config.seatConfigs[seat]));

  const currentInput = game.result ? null : matchRef.current.getTurnInput();
  const inspectorHandGroups = currentInput ? buildInspectorHandGroups(currentInput.hand) : [];
  const promptPreview = currentInput ? formatTurnInputAsPrompt(currentInput) : '';
  const visibleSeats = ARENA_SEATS.map((seat) => ({
    seat,
    player: game.players[seat],
    trace: game.roundTrace[seat],
    handGroups: buildInspectorHandGroups(game.players[seat].hand),
    active: game.currentPlayer === seat && !game.result,
  }));

  useEffect(() => {
    matchRef.current = createSpectatorMatch(config, {
      onLlmStatus: appendLlmStatus,
      siteUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
    });
    setGame(matchRef.current.getState());
    setRuntimeError(null);
    setAutoRun(false);
    setLogs([]);
    setLlmStatusLog([]);
    setLlmSeatStatus({});
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

  function appendLlmStatus(entry: OpenRouterStatusEvent): void {
    const nextEntry: ArenaLlmStatusEntry = {
      ...entry,
      id: `${entry.timestamp}-${llmStatusSequenceRef.current + 1}`,
    };

    llmStatusSequenceRef.current += 1;
    setLlmStatusLog((current) => [nextEntry, ...current].slice(0, 28));

    if (entry.seat !== undefined) {
      setLlmSeatStatus((current) => ({
        ...current,
        [entry.seat as Seat]: nextEntry,
      }));
    }
  }

  function handleToggleAutoRun(): void {
    if (game.result) {
      return;
    }

    setAutoRun((current) => !current);
  }

  function handleRestart(): void {
    matchRef.current = createSpectatorMatch(config, {
      onLlmStatus: appendLlmStatus,
      siteUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
    });
    setGame(matchRef.current.getState());
    setRuntimeError(null);
    setAutoRun(false);
    setLogs([]);
    setLlmStatusLog([]);
    setLlmSeatStatus({});
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
        { seat: 2, position: 'top', subtitle: getSeatSubtitle(config.seatConfigs[2]) },
        { seat: 3, position: 'left', subtitle: getSeatSubtitle(config.seatConfigs[3]) },
        { seat: 1, position: 'right', subtitle: getSeatSubtitle(config.seatConfigs[1]) },
        { seat: 0, position: 'bottom', subtitle: getSeatSubtitle(config.seatConfigs[0]) },
      ]}
      afterStage={
        <section className="arena-dashboard">
          <section className="arena-panel arena-open-table-panel">
            <div className="arena-panel-header">
              <div>
                <span className="label">本轮出牌</span>
                <strong>只显示 4 个 player 这一轮打出的牌、状态和剩余张数</strong>
              </div>
            </div>

            <div className="arena-open-table-grid">
              {visibleSeats.map(({ seat, player, trace, handGroups, active }) => (
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

          {remoteSeats.length > 0 ? (
            <section className="arena-panel arena-llm-status-panel">
              <div className="arena-panel-header">
                <div>
                  <span className="label">LLM Status</span>
                  <strong>最近模型请求、非法 JSON、repair 和 fallback 诊断</strong>
                </div>
              </div>

              <div className="arena-llm-status-grid">
                {remoteSeats.map((seat) => {
                  const status = llmSeatStatus[seat];

                  return (
                    <article className="arena-llm-seat-card" key={`llm-status-seat-${seat}`}>
                      <div className="arena-llm-seat-header">
                        <div>
                          <span className="eyebrow">
                            Seat {seat} · {getSeatTitle(seat)}
                          </span>
                          <strong>{getSeatDisplayLabel(config.seatConfigs[seat])}</strong>
                        </div>
                        <span className={`arena-llm-status-pill ${status?.level ?? 'info'}`}>
                          {status ? getLlmStatusLabel(status.code) : '等待请求'}
                        </span>
                      </div>

                      <div className="arena-summary-model">{getSeatModeSummary(config.seatConfigs[seat])}</div>
                      <p className="arena-llm-status-message">
                        {status ? status.message : '这一家还没有发起模型请求。'}
                      </p>
                      <div className="arena-llm-status-meta">
                        {status ? `${formatStatusTimestamp(status.timestamp)} · ${status.model}` : getSeatLlmModelLabel(config.seatConfigs[seat])}
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="arena-llm-status-list">
                {llmStatusLog.length > 0 ? (
                  llmStatusLog.map((entry) => (
                    <article className="arena-llm-status-entry" key={entry.id}>
                      <div className="arena-llm-status-topline">
                        <div>
                          <strong>
                            Seat {entry.seat ?? '-'} · {entry.agentLabel}
                          </strong>
                          <span>
                            {formatStatusTimestamp(entry.timestamp)} · {entry.model}
                          </span>
                        </div>
                        <span className={`arena-llm-status-pill ${entry.level}`}>{getLlmStatusLabel(entry.code)}</span>
                      </div>
                      <p>{entry.message}</p>
                      {entry.detail ? <pre className="arena-llm-status-detail">{entry.detail}</pre> : null}
                    </article>
                  ))
                ) : (
                  <div className="arena-empty">模型状态会在请求、repair、fallback 时实时出现在这里。</div>
                )}
              </div>
            </section>
          ) : null}

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

  if (config.mode === 'builtin-legacy-vR') {
    return 'guandan-ai vR';
  }

  if (config.mode === 'builtin-legacy-v3') {
    return 'legacy v3';
  }

  if (config.mode === 'builtin-legacy-v1') {
    return 'guandan-ai v1 legacy';
  }

  if (config.mode === 'builtin-baseline') {
    return '基础内置 heuristic';
  }

  if (config.mode === 'scorenet-ppo') {
    return 'ScoreNet PPO learned policy';
  }

  if (config.mode === 'llmreranker') {
    return `LLM reranker · ${getSeatLlmModelLabel(config)}`;
  }

  return getSeatLlmModelLabel(config);
}

function usesRemoteModel(config: SpectatorSeatConfig): boolean {
  return config.mode === 'openrouter' || config.mode === 'llmreranker';
}

function getLlmStatusLabel(code: OpenRouterStatusCode): string {
  if (code === 'requesting') {
    return '请求中';
  }

  if (code === 'success') {
    return '成功';
  }

  if (code === 'request_error') {
    return '接口失败';
  }

  if (code === 'invalid_json') {
    return '非法 JSON';
  }

  if (code === 'repairing') {
    return '修复中';
  }

  if (code === 'repair_success') {
    return '修复成功';
  }

  if (code === 'fallback') {
    return '已 fallback';
  }

  return '已跳过';
}

function formatStatusTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getSeatLlmModelLabel(config: SpectatorSeatConfig): string {
  if (config.mode === 'llmreranker') {
    return config.model || OPENROUTER_DEFAULT_RERANKER_MODEL;
  }

  return config.model || '未设模型';
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

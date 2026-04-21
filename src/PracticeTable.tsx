import { useEffect, useMemo, useState } from 'react';
import { chooseAiAction } from './game/ai';
import { enumerateExactPlays, filterLegalPlays, getPlayDisplayRank, sortPlayOptionsForContext } from './game/rules';
import { applyPass, applyPlay, createNewGame, getSeatStatus } from './game/state';
import type { Card, GameState, PlayerState, Suit } from './game/types';
import GameTableScene from './table/GameTableScene';
import { PlayingCard, formatPlacementKey } from './ui/tableWidgets';
import { applyArenaChosenAction, buildArenaTurnInput } from './arena/engine';
import { createOpenRouterAgent } from './arena/openrouter';

type PracticeAiMode = 'legacy' | 'openrouter';

const DEEPSEEK_V3_MODEL = 'deepseek/deepseek-chat-v3-0324';
const PRACTICE_OPENROUTER_KEY_STORAGE = 'guandan-practice-openrouter-key';
const PRACTICE_LEGACY_PROFILE = 'legacy-v3.0' as const;

export default function PracticeTable() {
  const [game, setGame] = useState<GameState>(() => createNewGame());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [organizedGroups, setOrganizedGroups] = useState<string[][]>([]);
  const [aiMode, setAiMode] = useState<PracticeAiMode>('legacy');
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [llmStatus, setLlmStatus] = useState('未启用');

  const human = game.players[0];
  const humanGroups = buildDisplayGroups(human.hand, organizedGroups);
  const straightFlushHints = getStraightFlushHints(human.hand);
  const currentTarget = game.tablePlay?.play ?? null;
  const selectedCards = human.hand.filter((card) => selectedIds.includes(card.id));
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

  const hasOpenRouterKey = openRouterApiKey.trim().length > 0;
  const aiModeLabel = aiMode === 'openrouter' ? 'OpenRouter / DeepSeek v3' : '内置 legacy-v3.0';

  const openRouterSeatAgent = useMemo(() => {
    if (!hasOpenRouterKey) {
      return null;
    }

    return createOpenRouterAgent({
      id: 'practice-openrouter-agent',
      label: 'Practice OpenRouter',
      apiKey: openRouterApiKey.trim(),
      model: DEEPSEEK_V3_MODEL,
      siteName: 'Guandan Practice',
      siteUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
      onStatus(event) {
        setLlmStatus(`${event.code}: ${event.message}`);
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
  }, [game, aiMode, openRouterSeatAgent]);

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

    const decision = chooseAiAction(game, actingSeat, PRACTICE_LEGACY_PROFILE);
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
  const canOrganize = humanTurn && selectedIds.length >= 2;
  const canRestore = humanTurn && organizedGroups.length > 0;
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

  function handleRestore(): void {
    if (!canRestore) {
      return;
    }

    setOrganizedGroups([]);
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
                onClick={showOrganizeAction ? handleOrganize : handleRestore}
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
            <span className="label">LLM 对战（BYOK / OpenRouter）</span>
            <strong>{aiModeLabel} · 仅支持 DeepSeek v3</strong>
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
                DeepSeek v3
              </button>
            </div>
            <div className="hud-key-row">
              <input
                className="hud-key-input"
                onChange={(event) => setOpenRouterApiKey(event.target.value)}
                placeholder="sk-or-v1-...（你的 OpenRouter key）"
                type="password"
                value={openRouterApiKey}
              />
            </div>
            <span className="label">状态：{aiMode === 'openrouter' ? llmStatus : '未启用'}</span>
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

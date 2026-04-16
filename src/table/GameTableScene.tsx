import type { ReactNode } from 'react';
import type { Card, GameState, Seat } from '../game/types';
import { PlayingCard, getAvatarGlyph } from '../ui/tableWidgets';

export interface TableBadge {
  label: string;
  value: string;
}

export interface TableSeatConfig {
  seat: Seat;
  position: 'top' | 'left' | 'right' | 'bottom';
  subtitle?: string;
  countLabel?: string;
  openHandCards?: Card[];
}

export interface GameTableSceneProps {
  game: GameState;
  leftBadges: TableBadge[];
  rightBadges: TableBadge[];
  centerPanel?: {
    eyebrow: string;
    title: string;
    note?: string;
  };
  showCenterPanel?: boolean;
  seats: TableSeatConfig[];
  onReset?: () => void;
  resetLabel?: string;
  stageClassName?: string;
  insideStage?: ReactNode;
  afterStage?: ReactNode;
}

export default function GameTableScene({
  game,
  leftBadges,
  rightBadges,
  centerPanel,
  showCenterPanel = true,
  seats,
  onReset,
  resetLabel = '重新发牌',
  stageClassName = '',
  insideStage,
  afterStage,
}: GameTableSceneProps) {
  return (
    <>
      <main className={`table-stage ${stageClassName}`.trim()}>
        <div className="stage-overlay top-left">
          {leftBadges.map((badge) => (
            <div className="rule-box" key={`${badge.label}-${badge.value}`}>
              <span className="rule-box-label">{badge.label}</span>
              <strong>{badge.value}</strong>
            </div>
          ))}
        </div>

        <div className="stage-overlay top-right">
          {rightBadges.map((badge) => (
            <div className="info-chip" key={`${badge.label}-${badge.value}`}>
              <span>{badge.label}</span>
              <strong>{badge.value}</strong>
            </div>
          ))}
          {onReset ? (
            <button className="ghost-button stage-button" onClick={onReset} type="button">
              {resetLabel}
            </button>
          ) : null}
        </div>

        {seats.map((seatConfig) => (
          <TableSeatPanel game={game} key={`${seatConfig.position}-${seatConfig.seat}`} {...seatConfig} />
        ))}

        {showCenterPanel && centerPanel ? (
          <section className="table-center-panel">
            <span className="eyebrow">{centerPanel.eyebrow}</span>
            <strong>{centerPanel.title}</strong>
            {centerPanel.note ? <span className="table-center-note">{centerPanel.note}</span> : null}
          </section>
        ) : null}

        {insideStage}
      </main>

      {afterStage}
    </>
  );
}

function TableSeatPanel({
  game,
  seat,
  position,
  subtitle,
  countLabel,
  openHandCards,
}: TableSeatConfig & {
  game: GameState;
}) {
  const player = game.players[seat];
  const trace = game.roundTrace[seat];
  const active = game.currentPlayer === seat && !game.result;
  const handGroups = openHandCards ? buildRankGroups(openHandCards) : [];

  return (
    <section className={`table-seat ${position} ${active ? 'active' : ''} ${handGroups.length > 0 ? 'open-hand' : ''}`}>
      <div className="table-seat-body">
        <div className="table-seat-profile">
          <div className={`player-avatar seat-${seat}`}>{getAvatarGlyph(seat)}</div>
          <div className="table-seat-meta">
            <strong>{player.name}</strong>
            {subtitle ? <span>{subtitle}</span> : null}
            <em>{countLabel ?? `${player.hand.length} 张`}</em>
          </div>
        </div>

        <div className={`table-seat-trace ${trace.action ? 'flash-in' : ''}`} key={`${seat}-${trace.action}`}>
          {trace.action ? (
            trace.play ? (
              <>
                <span className="trace-label">{trace.play.label}</span>
                <div className="trace-cards-row">
                  {trace.play.cards.map((card) => (
                    <PlayingCard card={card} compact key={`${seat}-${card.id}`} trace />
                  ))}
                </div>
              </>
            ) : (
              <span className="trace-pass">不出</span>
            )
          ) : (
            <span className="trace-empty">等待首个动作</span>
          )}
        </div>
      </div>

      {handGroups.length > 0 ? (
        <div className="table-seat-hand-preview" role="list" aria-label={`${player.name} 的公开手牌预览`}>
          {handGroups.map((group) => (
            <div className="table-seat-hand-column" key={group.map((card) => card.id).join('|')}>
              {group.map((card, index) => (
                <div
                  className="table-seat-hand-card"
                  key={card.id}
                  style={{
                    zIndex: group.length - index,
                    transform: `translateY(${-index * 20}px)`,
                  }}
                >
                  <PlayingCard card={card} grouped />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function buildRankGroups(cards: Card[]): Card[][] {
  const groups: Card[][] = [];

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

import { getCardAriaLabel, getCardRankText, getCardSuitText, getCardTone } from '../game/cards';
import type { Card, Seat } from '../game/types';

export function PlayingCard({
  card,
  selected = false,
  compact = false,
  grouped = false,
  trace = false,
}: {
  card: Card;
  selected?: boolean;
  compact?: boolean;
  grouped?: boolean;
  trace?: boolean;
}) {
  const tone = getCardTone(card);

  return (
    <div
      aria-label={getCardAriaLabel(card)}
      className={`playing-card ${tone} ${card.isWild ? 'wild' : ''} ${compact ? 'compact' : ''} ${
        grouped ? 'grouped' : ''
      } ${trace ? 'trace' : ''} ${selected ? 'selected' : ''} ${
        card.rank === 'SJ' ? 'joker-small' : card.rank === 'BJ' ? 'joker-big' : ''
      }`}
      role="img"
    >
      <div className="corner">
        <strong>{getCardRankText(card)}</strong>
        <span>{getCardSuitText(card)}</span>
      </div>
      {!((compact || grouped) && (card.rank === 'SJ' || card.rank === 'BJ')) ? (
        <div className={`center-glyph ${card.rank === 'SJ' || card.rank === 'BJ' ? 'joker' : ''}`}>
          {card.rank === 'SJ' || card.rank === 'BJ' ? 'JOKER' : getCardSuitText(card)}
        </div>
      ) : null}
      {card.isWild && !compact ? <div className="wild-badge">万能</div> : null}
    </div>
  );
}

export function getAvatarGlyph(seat: Seat): string {
  if (seat === 2) {
    return '队';
  }

  if (seat === 1) {
    return '右';
  }

  if (seat === 3) {
    return '左';
  }

  return '你';
}

export function formatPlacementKey(placementKey: string): string {
  return placementKey.split('').join('-');
}

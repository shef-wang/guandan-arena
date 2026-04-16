/**
 * Simple anonymous persistent identity.
 * Players get a random ID on first connection; they can optionally
 * provide a stored playerId to resume their identity (via localStorage on client).
 * Upgradeable to real auth (OAuth, etc.) later.
 */

const playerStore = new Map<string, PlayerRecord>();

export interface PlayerRecord {
  playerId: string;
  displayName: string;
  rating: number;
  ratingDeviation: number;
  volatility: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  createdAt: number;
  lastActive: number;
}

const DEFAULT_RATING = 1500;
const DEFAULT_RD = 350;
const DEFAULT_VOLATILITY = 0.06;

export function getOrCreatePlayer(playerId?: string): PlayerRecord {
  if (playerId && playerStore.has(playerId)) {
    const player = playerStore.get(playerId)!;
    player.lastActive = Date.now();
    return player;
  }

  const id = playerId ?? generatePlayerId();
  const record: PlayerRecord = {
    playerId: id,
    displayName: `Player-${id.slice(-6)}`,
    rating: DEFAULT_RATING,
    ratingDeviation: DEFAULT_RD,
    volatility: DEFAULT_VOLATILITY,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  playerStore.set(id, record);
  return record;
}

export function getPlayer(playerId: string): PlayerRecord | null {
  return playerStore.get(playerId) ?? null;
}

export function updatePlayer(playerId: string, update: Partial<PlayerRecord>): void {
  const player = playerStore.get(playerId);
  if (player) {
    Object.assign(player, update);
  }
}

export function getLeaderboard(limit: number = 50): PlayerRecord[] {
  return [...playerStore.values()]
    .filter((p) => p.gamesPlayed >= 3)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit);
}

export function getAllPlayers(): PlayerRecord[] {
  return [...playerStore.values()];
}

function generatePlayerId(): string {
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

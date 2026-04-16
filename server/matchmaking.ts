import type { Seat } from '../src/game/types';
import type { RoomConfig, SeatAssignment } from './protocol';
import { getOrCreatePlayer, type PlayerRecord } from './auth';

export interface QueueEntry {
  playerId: string;
  rating: number;
  joinedAt: number;
}

const queue: QueueEntry[] = [];
const MATCH_RATING_TOLERANCE = 300;
const MATCH_TIMEOUT_MS = 30_000;

export function addToQueue(playerId: string): void {
  if (queue.some((e) => e.playerId === playerId)) return;
  const player = getOrCreatePlayer(playerId);
  queue.push({
    playerId,
    rating: player.rating,
    joinedAt: Date.now(),
  });
}

export function removeFromQueue(playerId: string): void {
  const idx = queue.findIndex((e) => e.playerId === playerId);
  if (idx >= 0) queue.splice(idx, 1);
}

export function isInQueue(playerId: string): boolean {
  return queue.some((e) => e.playerId === playerId);
}

export function getQueueSize(): number {
  return queue.length;
}

/**
 * Try to form a match. Returns a RoomConfig if enough players are found,
 * otherwise returns null. Unfilled seats are filled with AI agents.
 *
 * For now: any 1-4 humans get matched together immediately, with AI filling
 * remaining seats. This can be made stricter (require 2+ humans, rating
 * proximity, etc.) later.
 */
export function tryFormMatch(): RoomConfig | null {
  if (queue.length === 0) return null;

  const now = Date.now();
  const eligible = queue.filter((e) => now - e.joinedAt < MATCH_TIMEOUT_MS);
  if (eligible.length === 0) {
    queue.length = 0;
    return null;
  }

  eligible.sort((a, b) => a.rating - b.rating);

  const matched: QueueEntry[] = [eligible[0]];
  for (let i = 1; i < eligible.length && matched.length < 4; i++) {
    if (Math.abs(eligible[i].rating - matched[0].rating) <= MATCH_RATING_TOLERANCE) {
      matched.push(eligible[i]);
    }
  }

  for (const entry of matched) {
    removeFromQueue(entry.playerId);
  }

  const seats: Record<Seat, SeatAssignment> = {
    0: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-fill-0' },
    1: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-fill-1' },
    2: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-fill-2' },
    3: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-fill-3' },
  };

  const humanSeats: Seat[] = [0, 2, 1, 3];
  for (let i = 0; i < matched.length; i++) {
    const seat = humanSeats[i];
    seats[seat] = { type: 'human', playerId: matched[i].playerId };
  }

  return { seatAssignments: seats };
}

/**
 * After a match finishes, record results and update player records.
 */
export function recordMatchResult(
  config: RoomConfig,
  winnerTeam: 0 | 1,
  levelDelta: number,
): void {
  for (const seat of [0, 1, 2, 3] as const) {
    const assignment = config.seatAssignments[seat];
    if (assignment.type !== 'human') continue;

    const player = getOrCreatePlayer(assignment.playerId);
    const playerTeam = seat === 0 || seat === 2 ? 0 : 1;
    const won = playerTeam === winnerTeam;

    player.gamesPlayed += 1;
    if (won) player.wins += 1;
    else player.losses += 1;
    player.lastActive = Date.now();
  }
}

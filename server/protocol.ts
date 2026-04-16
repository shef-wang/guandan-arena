import type { Seat, GameResult } from '../src/game/types';
import type { ArenaTurnInput, ArenaChosenAction, AgentType } from '../src/arena/types';

export interface RoomConfig {
  seatAssignments: Record<Seat, SeatAssignment>;
  seed?: number;
}

export type SeatAssignment =
  | { type: 'human'; playerId: string }
  | { type: 'agent'; agentType: AgentType; agentId: string };

export type ServerMessage =
  | { type: 'room_created'; roomId: string; config: RoomConfig }
  | { type: 'room_joined'; roomId: string; seat: Seat; config: RoomConfig }
  | { type: 'room_state'; roomId: string; state: RoomStateView }
  | { type: 'turn_request'; roomId: string; input: ArenaTurnInput }
  | { type: 'turn_played'; roomId: string; seat: Seat; action: ArenaChosenAction; message: string }
  | { type: 'game_finished'; roomId: string; result: GameResult; finishOrder: Seat[] }
  | { type: 'error'; message: string }
  | { type: 'lobby_update'; rooms: LobbyRoomInfo[] }
  | { type: 'player_joined'; roomId: string; seat: Seat; playerId: string }
  | { type: 'player_left'; roomId: string; seat: Seat }
  | { type: 'auth_ok'; playerId: string; displayName: string; rating: number }
  | { type: 'leaderboard'; entries: LeaderboardEntry[] }
  | { type: 'queue_status'; position: number; queueSize: number }
  | { type: 'match_found'; roomId: string; seat: Seat; config: RoomConfig }
  | { type: 'rating_update'; playerId: string; oldRating: number; newRating: number };

export type ClientMessage =
  | { type: 'create_room'; config: RoomConfig }
  | { type: 'join_room'; roomId: string; preferredSeat?: Seat }
  | { type: 'submit_action'; roomId: string; action: ArenaChosenAction }
  | { type: 'leave_room'; roomId: string }
  | { type: 'list_rooms' }
  | { type: 'spectate_room'; roomId: string }
  | { type: 'auth'; playerId?: string; displayName?: string }
  | { type: 'get_leaderboard' }
  | { type: 'queue_matchmaking' }
  | { type: 'cancel_matchmaking' };

export interface LeaderboardEntry {
  playerId: string;
  displayName: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
}

export interface RoomStateView {
  seats: Array<{
    seat: Seat;
    assignment: SeatAssignment;
    connected: boolean;
  }>;
  gameStarted: boolean;
  currentPlayer: Seat;
  message: string;
  finishOrder: Seat[];
  result: GameResult | null;
}

export interface LobbyRoomInfo {
  roomId: string;
  humanCount: number;
  agentCount: number;
  gameStarted: boolean;
  spectatorCount: number;
}

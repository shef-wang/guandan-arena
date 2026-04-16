import { useCallback, useEffect, useRef, useState } from 'react';
import type { Seat } from '../game/types';
import type { ArenaChosenAction, ArenaTurnInput } from '../arena/types';
import type { ServerMessage, ClientMessage, RoomConfig, RoomStateView, LobbyRoomInfo, LeaderboardEntry } from '../../server/protocol';

export interface ArenaSocketState {
  connected: boolean;
  playerId: string | null;
  displayName: string | null;
  rating: number | null;
  roomId: string | null;
  seat: Seat | null;
  roomState: RoomStateView | null;
  turnInput: ArenaTurnInput | null;
  lobbyRooms: LobbyRoomInfo[];
  leaderboard: LeaderboardEntry[];
  error: string | null;
  messages: string[];
  finished: boolean;
  inQueue: boolean;
  ratingChange: { oldRating: number; newRating: number } | null;
}

export interface ArenaSocketActions {
  createRoom: (config: RoomConfig) => void;
  joinRoom: (roomId: string, preferredSeat?: Seat) => void;
  submitAction: (action: ArenaChosenAction) => void;
  leaveRoom: () => void;
  listRooms: () => void;
  spectateRoom: (roomId: string) => void;
  getLeaderboard: () => void;
  queueMatchmaking: () => void;
  cancelMatchmaking: () => void;
  authenticate: (playerId?: string, displayName?: string) => void;
}

const DEFAULT_WS_URL = `ws://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:8787`;

export function useArenaSocket(wsUrl: string = DEFAULT_WS_URL): [ArenaSocketState, ArenaSocketActions] {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ArenaSocketState>({
    connected: false,
    playerId: null,
    displayName: null,
    rating: null,
    roomId: null,
    seat: null,
    roomState: null,
    turnInput: null,
    lobbyRooms: [],
    leaderboard: [],
    error: null,
    messages: [],
    finished: false,
    inQueue: false,
    ratingChange: null,
  });

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setState((s) => ({ ...s, connected: true, error: null }));
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, connected: false }));
    };

    ws.onerror = () => {
      setState((s) => ({ ...s, error: 'WebSocket connection error' }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      handleServerMessage(msg);
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  function handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'auth_ok':
        setState((s) => ({
          ...s,
          playerId: msg.playerId,
          displayName: msg.displayName,
          rating: msg.rating,
        }));
        break;
      case 'lobby_update':
        setState((s) => ({ ...s, lobbyRooms: msg.rooms }));
        break;
      case 'room_created':
        setState((s) => ({ ...s, roomId: msg.roomId }));
        break;
      case 'room_joined':
        setState((s) => ({
          ...s,
          roomId: msg.roomId,
          seat: msg.seat,
          error: null,
          inQueue: false,
        }));
        break;
      case 'room_state':
        setState((s) => ({
          ...s,
          roomState: msg.state,
          finished: msg.state.result !== null,
        }));
        break;
      case 'turn_request':
        setState((s) => ({ ...s, turnInput: msg.input }));
        break;
      case 'turn_played':
        setState((s) => ({
          ...s,
          messages: [...s.messages.slice(-49), `Seat ${msg.seat}: ${msg.message}`],
          turnInput: null,
        }));
        break;
      case 'game_finished':
        setState((s) => ({
          ...s,
          finished: true,
          messages: [...s.messages, `Game finished: ${msg.result.summary}`],
        }));
        break;
      case 'error':
        setState((s) => ({ ...s, error: msg.message }));
        break;
      case 'leaderboard':
        setState((s) => ({ ...s, leaderboard: msg.entries }));
        break;
      case 'queue_status':
        setState((s) => ({ ...s, inQueue: msg.position > 0 }));
        break;
      case 'match_found':
        setState((s) => ({
          ...s,
          roomId: msg.roomId,
          seat: msg.seat,
          inQueue: false,
        }));
        break;
      case 'rating_update':
        setState((s) => ({
          ...s,
          rating: msg.newRating,
          ratingChange: { oldRating: msg.oldRating, newRating: msg.newRating },
        }));
        break;
    }
  }

  const sendMsg = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const actions: ArenaSocketActions = {
    createRoom: useCallback((config: RoomConfig) => {
      sendMsg({ type: 'create_room', config });
    }, [sendMsg]),
    joinRoom: useCallback((roomId: string, preferredSeat?: Seat) => {
      sendMsg({ type: 'join_room', roomId, preferredSeat });
    }, [sendMsg]),
    submitAction: useCallback((action: ArenaChosenAction) => {
      if (state.roomId) {
        sendMsg({ type: 'submit_action', roomId: state.roomId, action });
        setState((s) => ({ ...s, turnInput: null }));
      }
    }, [sendMsg, state.roomId]),
    leaveRoom: useCallback(() => {
      if (state.roomId) {
        sendMsg({ type: 'leave_room', roomId: state.roomId });
        setState((s) => ({
          ...s,
          roomId: null,
          seat: null,
          roomState: null,
          turnInput: null,
          finished: false,
          messages: [],
          ratingChange: null,
        }));
      }
    }, [sendMsg, state.roomId]),
    listRooms: useCallback(() => {
      sendMsg({ type: 'list_rooms' });
    }, [sendMsg]),
    spectateRoom: useCallback((roomId: string) => {
      sendMsg({ type: 'spectate_room', roomId });
    }, [sendMsg]),
    getLeaderboard: useCallback(() => {
      sendMsg({ type: 'get_leaderboard' });
    }, [sendMsg]),
    queueMatchmaking: useCallback(() => {
      sendMsg({ type: 'queue_matchmaking' });
      setState((s) => ({ ...s, inQueue: true }));
    }, [sendMsg]),
    cancelMatchmaking: useCallback(() => {
      sendMsg({ type: 'cancel_matchmaking' });
      setState((s) => ({ ...s, inQueue: false }));
    }, [sendMsg]),
    authenticate: useCallback((playerId?: string, displayName?: string) => {
      sendMsg({ type: 'auth', playerId, displayName });
    }, [sendMsg]),
  };

  return [state, actions];
}

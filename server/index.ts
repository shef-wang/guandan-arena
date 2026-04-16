import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import type { Seat } from '../src/game/types';
import type { ClientMessage, ServerMessage, LobbyRoomInfo, RoomConfig } from './protocol';
import { GameRoom } from './room';
import { getOrCreatePlayer, getLeaderboard, updatePlayer, type PlayerRecord } from './auth';
import { updateTeamRatings, type Glicko2Rating } from './glicko2';
import { addToQueue, removeFromQueue, tryFormMatch, getQueueSize, recordMatchResult } from './matchmaking';

const PORT = Number(process.env.PORT ?? '8787');

interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  playerRecord: PlayerRecord;
  roomId: string | null;
  seat: Seat | null;
  spectating: string | null;
}

const rooms = new Map<string, GameRoom>();
const clients = new Map<WebSocket, ConnectedClient>();
let roomCounter = 0;

function generateRoomId(): string {
  roomCounter++;
  return `room-${roomCounter}-${Date.now().toString(36)}`;
}

function generatePlayerId(): string {
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastLobbyUpdate(): void {
  const roomList = getLobbyRoomList();
  const msg: ServerMessage = { type: 'lobby_update', rooms: roomList };
  for (const [ws, client] of clients) {
    if (!client.roomId && !client.spectating) {
      send(ws, msg);
    }
  }
}

function getLobbyRoomList(): LobbyRoomInfo[] {
  const list: LobbyRoomInfo[] = [];
  for (const [roomId, room] of rooms) {
    const assignments = room.config.seatAssignments;
    let humanCount = 0;
    let agentCount = 0;
    for (const seat of [0, 1, 2, 3] as const) {
      if (assignments[seat].type === 'human') humanCount++;
      else agentCount++;
    }
    let spectatorCount = 0;
    for (const [, c] of clients) {
      if (c.spectating === roomId) spectatorCount++;
    }
    list.push({
      roomId,
      humanCount,
      agentCount,
      gameStarted: !room.finished,
      spectatorCount,
    });
  }
  return list;
}

function handleCreateRoom(ws: WebSocket, client: ConnectedClient, config: RoomConfig): void {
  const roomId = generateRoomId();
  const room = new GameRoom(roomId, config);
  rooms.set(roomId, room);

  send(ws, { type: 'room_created', roomId, config });

  for (const seat of [0, 1, 2, 3] as const) {
    const assignment = config.seatAssignments[seat];
    if (assignment.type === 'human' && assignment.playerId === client.playerId) {
      client.roomId = roomId;
      client.seat = seat;
      room.connectHuman(seat, client.playerId);
      send(ws, { type: 'room_joined', roomId, seat, config });
      break;
    }
  }

  broadcastLobbyUpdate();
  startGameLoop(roomId, room);
}

function handleJoinRoom(ws: WebSocket, client: ConnectedClient, roomId: string, preferredSeat?: Seat): void {
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', message: `Room ${roomId} not found.` });
    return;
  }

  let assignedSeat: Seat | null = null;

  if (preferredSeat != null && room.isHumanSeat(preferredSeat)) {
    assignedSeat = preferredSeat;
  } else {
    for (const seat of [0, 1, 2, 3] as const) {
      if (room.isHumanSeat(seat)) {
        assignedSeat = seat;
        break;
      }
    }
  }

  if (assignedSeat === null) {
    send(ws, { type: 'error', message: 'No available human seat in this room.' });
    return;
  }

  client.roomId = roomId;
  client.seat = assignedSeat;
  room.connectHuman(assignedSeat, client.playerId);

  send(ws, { type: 'room_joined', roomId, seat: assignedSeat, config: room.config });
  send(ws, { type: 'room_state', roomId, state: room.getStateView() });

  room.broadcast({ type: 'player_joined', roomId, seat: assignedSeat, playerId: client.playerId });

  const state = room.getState();
  if (state.currentPlayer === assignedSeat && room.isHumanSeat(assignedSeat)) {
    send(ws, { type: 'turn_request', roomId, input: room.getTurnInput(assignedSeat) });
  }
}

function handleSubmitAction(ws: WebSocket, client: ConnectedClient, roomId: string, action: import('../src/arena/types').ArenaChosenAction): void {
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', message: `Room ${roomId} not found.` });
    return;
  }

  if (client.seat === null) {
    send(ws, { type: 'error', message: 'You are not seated in this room.' });
    return;
  }

  const submitted = room.submitHumanAction(client.seat, action);
  if (!submitted) {
    send(ws, { type: 'error', message: 'It is not your turn or action already submitted.' });
  }
}

function handleLeaveRoom(ws: WebSocket, client: ConnectedClient, roomId: string): void {
  const room = rooms.get(roomId);
  if (room && client.seat !== null) {
    room.disconnectHuman(client.seat);
    room.broadcast({ type: 'player_left', roomId, seat: client.seat });
  }
  client.roomId = null;
  client.seat = null;
  broadcastLobbyUpdate();
}

function handleSpectate(ws: WebSocket, client: ConnectedClient, roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', message: `Room ${roomId} not found.` });
    return;
  }

  client.spectating = roomId;
  send(ws, { type: 'room_state', roomId, state: room.getStateView() });

  room.addSpectator((msg) => {
    send(ws, msg as ServerMessage);
  });
}

function startGameLoop(roomId: string, room: GameRoom): void {
  room.runGameLoop(
    (seat, input) => {
      for (const [ws, client] of clients) {
        if (client.roomId === roomId && client.seat === seat) {
          send(ws, { type: 'turn_request', roomId, input });
        }
      }
    },
    (seat, action, state) => {
      const msg: ServerMessage = {
        type: 'turn_played',
        roomId,
        seat,
        action,
        message: state.message,
      };
      for (const [ws, client] of clients) {
        if (client.roomId === roomId || client.spectating === roomId) {
          send(ws, msg);
        }
      }
    },
    (result, finishOrder) => {
      const msg: ServerMessage = { type: 'game_finished', roomId, result, finishOrder };
      for (const [ws, client] of clients) {
        if (client.roomId === roomId || client.spectating === roomId) {
          send(ws, msg);
        }
      }
      applyEloUpdates(room);
      broadcastLobbyUpdate();
    },
  ).catch((err) => {
    const message = err instanceof Error ? err.message : 'Unknown game loop error';
    for (const [ws, client] of clients) {
      if (client.roomId === roomId) {
        send(ws, { type: 'error', message });
      }
    }
  });
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    server: 'guandan-arena',
    rooms: getLobbyRoomList(),
  }));
});

const wss = new WebSocketServer({ server: httpServer });

function handleAuth(ws: WebSocket, client: ConnectedClient, playerId?: string, displayName?: string): void {
  const record = getOrCreatePlayer(playerId);
  if (displayName) {
    updatePlayer(record.playerId, { displayName });
    record.displayName = displayName;
  }
  client.playerId = record.playerId;
  client.playerRecord = record;
  send(ws, {
    type: 'auth_ok',
    playerId: record.playerId,
    displayName: record.displayName,
    rating: record.rating,
  });
}

function handleGetLeaderboard(ws: WebSocket): void {
  const entries = getLeaderboard(50).map((p) => ({
    playerId: p.playerId,
    displayName: p.displayName,
    rating: Math.round(p.rating),
    gamesPlayed: p.gamesPlayed,
    wins: p.wins,
    losses: p.losses,
  }));
  send(ws, { type: 'leaderboard', entries });
}

function handleQueueMatchmaking(ws: WebSocket, client: ConnectedClient): void {
  addToQueue(client.playerId);
  send(ws, { type: 'queue_status', position: 1, queueSize: getQueueSize() });

  const matchConfig = tryFormMatch();
  if (matchConfig) {
    const roomId = generateRoomId();
    const room = new GameRoom(roomId, matchConfig);
    rooms.set(roomId, room);

    for (const [clientWs, c] of clients) {
      for (const seat of [0, 1, 2, 3] as const) {
        const assignment = matchConfig.seatAssignments[seat];
        if (assignment.type === 'human' && assignment.playerId === c.playerId) {
          c.roomId = roomId;
          c.seat = seat;
          room.connectHuman(seat, c.playerId);
          send(clientWs, { type: 'match_found', roomId, seat, config: matchConfig });
          break;
        }
      }
    }

    broadcastLobbyUpdate();
    startGameLoop(roomId, room);
  }
}

function handleCancelMatchmaking(ws: WebSocket, client: ConnectedClient): void {
  removeFromQueue(client.playerId);
  send(ws, { type: 'queue_status', position: 0, queueSize: getQueueSize() });
}

function applyEloUpdates(room: GameRoom): void {
  const state = room.getState();
  if (!state.result) return;

  const config = room.config;
  const winnerTeam = state.result.winnerTeam;

  recordMatchResult(config, winnerTeam as 0 | 1, state.result.levelDelta);

  const team0Players: { playerId: string; rating: Glicko2Rating }[] = [];
  const team1Players: { playerId: string; rating: Glicko2Rating }[] = [];

  for (const seat of [0, 1, 2, 3] as const) {
    const assignment = config.seatAssignments[seat];
    if (assignment.type !== 'human') continue;

    const player = getOrCreatePlayer(assignment.playerId);
    const entry = {
      playerId: player.playerId,
      rating: { rating: player.rating, rd: player.ratingDeviation, volatility: player.volatility },
    };

    if (seat === 0 || seat === 2) team0Players.push(entry);
    else team1Players.push(entry);
  }

  if (team0Players.length === 0 && team1Players.length === 0) return;

  const winners = winnerTeam === 0 ? team0Players : team1Players;
  const losers = winnerTeam === 0 ? team1Players : team0Players;

  if (winners.length > 0 && losers.length > 0) {
    const result = updateTeamRatings(
      winners.map((w) => w.rating),
      losers.map((l) => l.rating),
    );

    for (let i = 0; i < winners.length; i++) {
      const oldRating = winners[i].rating.rating;
      updatePlayer(winners[i].playerId, {
        rating: result.winners[i].rating,
        ratingDeviation: result.winners[i].rd,
        volatility: result.winners[i].volatility,
      });
      notifyRatingUpdate(winners[i].playerId, oldRating, result.winners[i].rating);
    }

    for (let i = 0; i < losers.length; i++) {
      const oldRating = losers[i].rating.rating;
      updatePlayer(losers[i].playerId, {
        rating: result.losers[i].rating,
        ratingDeviation: result.losers[i].rd,
        volatility: result.losers[i].volatility,
      });
      notifyRatingUpdate(losers[i].playerId, oldRating, result.losers[i].rating);
    }
  }
}

function notifyRatingUpdate(playerId: string, oldRating: number, newRating: number): void {
  for (const [ws, client] of clients) {
    if (client.playerId === playerId) {
      send(ws, {
        type: 'rating_update',
        playerId,
        oldRating: Math.round(oldRating),
        newRating: Math.round(newRating),
      });
    }
  }
}

wss.on('connection', (ws) => {
  const initialRecord = getOrCreatePlayer();
  const client: ConnectedClient = {
    ws,
    playerId: initialRecord.playerId,
    playerRecord: initialRecord,
    roomId: null,
    seat: null,
    spectating: null,
  };
  clients.set(ws, client);

  send(ws, {
    type: 'auth_ok',
    playerId: initialRecord.playerId,
    displayName: initialRecord.displayName,
    rating: initialRecord.rating,
  });
  send(ws, { type: 'lobby_update', rooms: getLobbyRoomList() });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;

      switch (msg.type) {
        case 'auth':
          handleAuth(ws, client, msg.playerId, msg.displayName);
          break;
        case 'create_room':
          handleCreateRoom(ws, client, msg.config);
          break;
        case 'join_room':
          handleJoinRoom(ws, client, msg.roomId, msg.preferredSeat);
          break;
        case 'submit_action':
          handleSubmitAction(ws, client, msg.roomId, msg.action);
          break;
        case 'leave_room':
          handleLeaveRoom(ws, client, msg.roomId);
          break;
        case 'list_rooms':
          send(ws, { type: 'lobby_update', rooms: getLobbyRoomList() });
          break;
        case 'spectate_room':
          handleSpectate(ws, client, msg.roomId);
          break;
        case 'get_leaderboard':
          handleGetLeaderboard(ws);
          break;
        case 'queue_matchmaking':
          handleQueueMatchmaking(ws, client);
          break;
        case 'cancel_matchmaking':
          handleCancelMatchmaking(ws, client);
          break;
      }
    } catch (err) {
      send(ws, { type: 'error', message: 'Invalid message format.' });
    }
  });

  ws.on('close', () => {
    removeFromQueue(client.playerId);
    if (client.roomId && client.seat !== null) {
      const room = rooms.get(client.roomId);
      if (room) {
        room.disconnectHuman(client.seat);
        room.broadcast({ type: 'player_left', roomId: client.roomId, seat: client.seat });
      }
    }
    clients.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Guandan Arena server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`HTTP: http://localhost:${PORT}`);
});

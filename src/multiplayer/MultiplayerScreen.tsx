import { useEffect, useState } from 'react';
import type { Seat } from '../game/types';
import type { ArenaChosenAction } from '../arena/types';
import type { RoomConfig } from '../../server/protocol';
import { useArenaSocket } from './useArenaSocket';

export default function MultiplayerScreen() {
  const [socketState, actions] = useArenaSocket();
  const [quickPlaySeat] = useState<Seat>(0);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  useEffect(() => {
    if (showLeaderboard && socketState.connected) {
      actions.getLeaderboard();
    }
  }, [showLeaderboard, socketState.connected]);

  function handleQuickPlay(): void {
    const config: RoomConfig = {
      seatAssignments: {
        0: { type: 'human', playerId: 'local-player' },
        1: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-seat-1' },
        2: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-seat-2' },
        3: { type: 'agent', agentType: 'heuristic', agentId: 'legacy-v1-seat-3' },
      },
    };
    actions.createRoom(config);
  }

  function handleChooseAction(action: ArenaChosenAction): void {
    actions.submitAction(action);
  }

  if (!socketState.connected) {
    return (
      <div className="app-shell">
        <section className="start-screen">
          <div className="start-hero">
            <span className="eyebrow">Multiplayer Arena</span>
            <h1>Connecting...</h1>
            <p>Waiting for connection to the game server.</p>
            {socketState.error && <p className="danger-copy">{socketState.error}</p>}
          </div>
        </section>
      </div>
    );
  }

  if (socketState.roomId && socketState.seat !== null) {
    return (
      <div className="app-shell">
        <header className="app-topbar">
          <div className="app-title-group">
            <span className="eyebrow">Room {socketState.roomId}</span>
            <h1>Seat {socketState.seat} — Multiplayer</h1>
          </div>
          <button className="ghost-button" onClick={actions.leaveRoom} type="button">Leave Room</button>
        </header>

        <section className="agent-mode-shell">
          <section className="agent-mode-panel stack">
            <h2>Game Status</h2>
            {socketState.finished ? (
              <>
                <p><strong>Game finished!</strong></p>
                {socketState.ratingChange && (
                  <p>
                    Rating: {socketState.ratingChange.oldRating} → {socketState.ratingChange.newRating}
                    {' '}({socketState.ratingChange.newRating > socketState.ratingChange.oldRating ? '+' : ''}
                    {socketState.ratingChange.newRating - socketState.ratingChange.oldRating})
                  </p>
                )}
              </>
            ) : (
              <p>Waiting for turns...</p>
            )}
            {socketState.error && <p className="danger-copy">{socketState.error}</p>}
          </section>

          {socketState.turnInput && (
            <section className="agent-mode-panel stack">
              <h2>Your Turn — Seat {socketState.seat}</h2>
              <p>Table: {socketState.turnInput.currentTablePlay
                ? `${socketState.turnInput.currentTablePlay.play.label} by Seat ${socketState.turnInput.currentTablePlay.owner}`
                : 'Lead'
              }</p>
              <p>Hand: {socketState.turnInput.hand.length} cards</p>

              <div className="agent-actions-list">
                {socketState.turnInput.legalActions.map((action) => {
                  const actionId = action.kind === 'pass' ? 'pass' : action.actionId;
                  const chosenAction: ArenaChosenAction = action.kind === 'pass'
                    ? { kind: 'pass' }
                    : { kind: 'play', actionId: action.actionId };

                  return (
                    <div className="agent-action-row" key={actionId}>
                      <div className="stack">
                        <strong>{action.label}</strong>
                        <span className="agent-action-id">{actionId}</span>
                      </div>
                      <button
                        className="secondary-button agent-choose-button"
                        onClick={() => handleChooseAction(chosenAction)}
                        type="button"
                      >
                        Choose
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="agent-mode-panel stack">
            <h2>Game Log</h2>
            <div className="arena-log-list">
              {socketState.messages.length > 0
                ? socketState.messages.slice().reverse().map((msg, i) => (
                    <div className="arena-log-entry" key={i}><p>{msg}</p></div>
                  ))
                : <p className="muted-copy">No actions yet.</p>
              }
            </div>
          </section>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-title-group">
          <span className="eyebrow">Multiplayer Arena</span>
          <h1>Lobby</h1>
          <p className="app-subtitle">
            {socketState.playerId
              ? `${socketState.displayName} | Rating: ${socketState.rating != null ? Math.round(socketState.rating) : '?'}`
              : 'Create a game or join an existing room.'}
          </p>
        </div>
        <div className="app-nav-row">
          <button className="ghost-button" onClick={() => setShowLeaderboard(!showLeaderboard)} type="button">
            {showLeaderboard ? 'Hide Leaderboard' : 'Leaderboard'}
          </button>
          <a className="ghost-button app-nav-link" href="/" onClick={(e) => { e.preventDefault(); window.history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}>
            Home
          </a>
        </div>
      </header>

      <section className="agent-mode-shell">
        <section className="agent-mode-grid">
          <section className="agent-mode-panel stack">
            <h2>Quick Play</h2>
            <p className="muted-copy">Start a game as Seat {quickPlaySeat} with 3 AI opponents.</p>
            <button className="primary-button" onClick={handleQuickPlay} type="button">
              Play vs 3 AI
            </button>
          </section>

          <section className="agent-mode-panel stack">
            <h2>Matchmaking</h2>
            <p className="muted-copy">Queue for a rated match. AI fills empty seats.</p>
            {socketState.inQueue ? (
              <>
                <p>Searching for match...</p>
                <button className="ghost-button" onClick={actions.cancelMatchmaking} type="button">
                  Cancel
                </button>
              </>
            ) : (
              <button className="primary-button" onClick={actions.queueMatchmaking} type="button">
                Find Match
              </button>
            )}
          </section>
        </section>

        {showLeaderboard && (
          <section className="agent-mode-panel stack">
            <h2>Leaderboard</h2>
            {socketState.leaderboard.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>#</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Player</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Rating</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>W</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>L</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Games</th>
                  </tr>
                </thead>
                <tbody>
                  {socketState.leaderboard.map((entry, i) => (
                    <tr key={entry.playerId} style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                      <td style={{ padding: '4px 8px' }}>{i + 1}</td>
                      <td style={{ padding: '4px 8px' }}>{entry.displayName}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px' }}>{Math.round(entry.rating)}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px' }}>{entry.wins}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px' }}>{entry.losses}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px' }}>{entry.gamesPlayed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted-copy">No players on leaderboard yet (need 3+ games).</p>
            )}
            <button className="ghost-button" onClick={actions.getLeaderboard} type="button">
              Refresh
            </button>
          </section>
        )}

        <section className="agent-mode-panel stack">
          <h2>Open Rooms ({socketState.lobbyRooms.length})</h2>
          {socketState.lobbyRooms.length > 0
            ? socketState.lobbyRooms.map((room) => (
                <div className="agent-action-row" key={room.roomId}>
                  <div className="stack">
                    <strong>{room.roomId}</strong>
                    <span className="muted-copy">
                      {room.humanCount} humans, {room.agentCount} agents
                      {room.spectatorCount > 0 && `, ${room.spectatorCount} spectators`}
                    </span>
                  </div>
                  <div>
                    <button className="secondary-button" onClick={() => actions.joinRoom(room.roomId)} type="button">
                      Join
                    </button>
                    <button className="ghost-button" onClick={() => actions.spectateRoom(room.roomId)} type="button" style={{ marginLeft: 8 }}>
                      Watch
                    </button>
                  </div>
                </div>
              ))
            : <p className="muted-copy">No rooms available. Create one above.</p>
          }
          <button className="ghost-button" onClick={actions.listRooms} type="button">
            Refresh
          </button>
        </section>
      </section>
    </div>
  );
}

import { useEffect, useState } from 'react';

import type { ArenaChosenAction } from '../arena/types';
import { getRankText } from '../game/cards';
import { SUIT_SYMBOLS, type GameResult } from '../game/types';
import { applyAgentAction, advanceAgentBatch, createAgentBatchState, type AgentBatchDecision } from './core';

export default function AgentModeScreen() {
  const [decision, setDecision] = useState<AgentBatchDecision>(() => createDecisionFromLocation());
  const [manualAction, setManualAction] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    function handlePopState(): void {
      setDecision(createDecisionFromLocation());
      setManualAction('');
      setActionError(null);
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function submitAction(action: ArenaChosenAction): void {
    try {
      setDecision((current) => applyAgentAction(current.batch, action));
      setManualAction('');
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  function handleManualSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = manualAction.trim();

    if (!trimmed) {
      setActionError('Missing action.');
      return;
    }

    if (trimmed === 'pass') {
      submitAction({ kind: 'pass' });
      return;
    }

    submitAction({ kind: 'play', actionId: trimmed });
  }

  const turn = decision.turnInput;
  const currentTableLabel = turn?.currentTablePlay ? `S${turn.currentTablePlay.owner} ${turn.currentTablePlay.play.label}` : 'lead';
  const visibleSummary = {
    status: decision.status,
    completedMatches: decision.summary.completedMatches,
    totalMatches: decision.summary.totalMatches,
    wins: decision.summary.wins,
    losses: decision.summary.losses,
    totalSignedLevelDelta: decision.summary.totalSignedLevelDelta,
    averageSignedLevelDelta: Number(decision.summary.averageSignedLevelDelta.toFixed(3)),
    averageTurns: Number(decision.summary.averageTurns.toFixed(2)),
    placementCounts: decision.summary.placementCounts,
    currentMatchNumber: decision.currentMatchNumber,
    currentSeed: decision.batch.currentSeed,
    turnNumber: decision.turnNumber,
  };

  const visibleTurn =
    turn &&
    ({
      match: decision.currentMatchNumber,
      turn: decision.turnNumber,
      seed: decision.batch.currentSeed,
      seat: turn.seat,
      currentPlayer: turn.currentPlayer,
      message: turn.message,
      table: currentTableLabel,
      players: turn.players.map((player) => ({
        seat: player.seat,
        team: player.team,
        handCount: player.handCount,
        finished: player.finished,
        finishPosition: player.finishPosition,
        lastAction: player.lastAction,
      })),
      hand: turn.hand.map(formatCard),
      finishOrder: turn.finishOrder,
      legalActions: turn.legalActions.map((action) => ({
        actionId: action.kind === 'pass' ? 'pass' : action.actionId,
        label: action.label,
        kind: action.kind,
        cards: action.play ? action.play.cards.map(formatCard) : [],
      })),
    });

  return (
    <main className="agent-mode-shell">
      <section className="agent-mode-panel stack">
        <h1>Guandan Agent Mode</h1>
        <p className="muted-copy">
          Text-first route for browsing agents. The page auto-runs every non-player seat with built-in legacy-v1 logic and only pauses when seat{' '}
          {decision.batch.config.playerSeat} needs to choose an action.
        </p>
        <div className="agent-link-row">
          <a className="ghost-button app-nav-link" href="/">
            Open Human Table
          </a>
          <a className="ghost-button app-nav-link" href="/agent?matches=10">
            Restart 10 Games
          </a>
        </div>
      </section>

      <section className="agent-mode-grid">
        <section className="agent-mode-panel stack">
          <h2>Batch Summary</h2>
          <pre>{JSON.stringify(visibleSummary, null, 2)}</pre>
        </section>

        <section className="agent-mode-panel stack">
          <h2>Quick Restart</h2>
          <form action="/agent" className="stack" method="get">
            <label className="agent-form-field">
              <span>Total matches</span>
              <input defaultValue={decision.batch.config.totalMatches} max={100} min={1} name="matches" type="number" />
            </label>
            <label className="agent-form-field">
              <span>Base seed</span>
              <input defaultValue={decision.batch.config.baseSeed} min={0} name="seed" type="number" />
            </label>
            <button className="primary-button agent-submit-button" type="submit">
              Start New Batch
            </button>
          </form>
        </section>
      </section>

      {actionError ? (
        <section className="agent-mode-panel stack">
          <h2>Last Error</h2>
          <p className="danger-copy">{actionError}</p>
        </section>
      ) : null}

      {decision.status === 'completed' ? (
        <section className="agent-mode-panel stack">
          <h2>Batch Complete</h2>
          <pre>
            {JSON.stringify(
              {
                ...visibleSummary,
                completedMatches: decision.batch.completedMatches.map((match) => formatMatchSummary(match)),
              },
              null,
              2,
            )}
          </pre>
        </section>
      ) : (
        <section className="agent-mode-panel stack">
          <h2>Decision Needed</h2>
          <pre>
            {JSON.stringify(
              {
                match: decision.currentMatchNumber,
                turn: decision.turnNumber,
                seed: decision.batch.currentSeed,
                table: currentTableLabel,
                message: turn?.message,
                legalActionCount: turn?.legalActions.length ?? 0,
              },
              null,
              2,
            )}
          </pre>

          <div className="stack">
            <h3>Current Hand</h3>
            <p className="agent-hand-row">{turn?.hand.map(formatCard).join(' ')}</p>
          </div>

          <div className="stack">
            <h3>Manual Submit</h3>
            <p className="muted-copy">Enter `pass` or paste a `play:...` action id.</p>
            <form className="stack" onSubmit={handleManualSubmit}>
              <input
                aria-label="Manual action id"
                autoComplete="off"
                onChange={(event) => setManualAction(event.target.value)}
                placeholder="pass or play:..."
                type="text"
                value={manualAction}
              />
              <button className="primary-button agent-submit-button" type="submit">
                Submit Action
              </button>
            </form>
          </div>

          <div className="stack">
            <h3>Legal Actions</h3>
            <div className="agent-actions-list">
              {turn?.legalActions.map((action) => {
                const actionId = action.kind === 'pass' ? 'pass' : action.actionId;
                const detail =
                  action.kind === 'pass'
                    ? 'Pass this turn.'
                    : `${action.label} | ${action.play?.type ?? 'play'} | ${action.play?.cards.map(formatCard).join(' ') ?? ''}`;

                return (
                  <div className="agent-action-row" data-action-id={actionId} key={actionId}>
                    <div className="stack">
                      <strong>{action.label}</strong>
                      <span className="agent-action-id">{actionId}</span>
                      <span className="muted-copy">{detail}</span>
                    </div>
                    <button
                      className="secondary-button agent-choose-button"
                      onClick={() =>
                        submitAction(
                          action.kind === 'pass'
                            ? {
                                kind: 'pass',
                              }
                            : {
                                kind: 'play',
                                actionId: action.actionId,
                              },
                        )
                      }
                      type="button"
                    >
                      Choose
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="stack">
            <h3>Machine-readable Turn JSON</h3>
            <pre>{JSON.stringify(visibleTurn, null, 2)}</pre>
          </div>
        </section>
      )}
    </main>
  );
}

function createDecisionFromLocation(): AgentBatchDecision {
  const params = new URLSearchParams(window.location.search);
  const matches = parseOptionalInteger(params.get('matches'));
  const seed = parseOptionalInteger(params.get('seed'));
  const seat = parseOptionalInteger(params.get('seat'));

  return advanceAgentBatch(
    createAgentBatchState({
      totalMatches: matches,
      baseSeed: seed,
      playerSeat: normalizeSeat(seat),
    }),
  );
}

function parseOptionalInteger(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSeat(value: number | undefined): 0 | 1 | 2 | 3 | undefined {
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }

  if (value === 0) {
    return 0;
  }

  return undefined;
}

function formatCard(card: { rank: string; suit: keyof typeof SUIT_SYMBOLS; isWild: boolean }): string {
  const suit = SUIT_SYMBOLS[card.suit] ?? card.suit;
  return `${suit}${getRankText(card.rank as never)}${card.isWild ? '*' : ''}`;
}

function formatMatchSummary(match: {
  matchNumber: number;
  seed: number;
  turns: number;
  playerSeat: number;
  playerTeam: number;
  playerWon: boolean;
  signedLevelDelta: number;
  result: GameResult;
  finishOrder: number[];
}): Record<string, unknown> {
  return {
    matchNumber: match.matchNumber,
    seed: match.seed,
    turns: match.turns,
    playerSeat: match.playerSeat,
    playerTeam: match.playerTeam,
    playerWon: match.playerWon,
    signedLevelDelta: match.signedLevelDelta,
    placementKey: match.result.placementKey,
    summary: match.result.summary,
    finishOrder: match.finishOrder,
  };
}

import { getRankText } from '../game/cards';
import { SUIT_SYMBOLS, type GameResult } from '../game/types';
import type { AgentBatchDecision, AgentMatchSummary } from './core';

export function renderAgentHtml(params: {
  decision: AgentBatchDecision;
  token: string;
  actionError?: string | null;
  requestUrl: string;
}): string {
  const { decision, token, actionError, requestUrl } = params;
  const currentTurn = decision.turnInput;
  const escapedToken = escapeHtml(token);
  const manualActionHelp = currentTurn ? currentTurn.legalActions.map((action) => action.kind === 'pass' ? 'pass' : action.actionId).join(', ') : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Guandan Agent Mode</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace;
        background: #06131d;
        color: #e8eef7;
      }
      body {
        margin: 0;
        padding: 20px;
        background:
          radial-gradient(circle at top right, rgba(76, 143, 227, 0.18), transparent 28%),
          linear-gradient(180deg, #0a1721 0%, #071019 100%);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        display: grid;
        gap: 18px;
      }
      section {
        border: 1px solid rgba(214, 229, 255, 0.18);
        border-radius: 16px;
        padding: 16px;
        background: rgba(10, 20, 31, 0.82);
      }
      h1, h2, h3, p, pre {
        margin: 0;
      }
      .stack {
        display: grid;
        gap: 10px;
      }
      .muted {
        color: rgba(232, 238, 247, 0.74);
      }
      .grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .actions {
        display: grid;
        gap: 10px;
      }
      .action-row {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
      }
      .action-copy {
        display: grid;
        gap: 4px;
      }
      .action-id {
        color: #8dd3ff;
        word-break: break-all;
      }
      button, input {
        font: inherit;
      }
      button {
        border: none;
        border-radius: 10px;
        padding: 10px 14px;
        cursor: pointer;
        background: linear-gradient(135deg, #d1ecff, #7fd0ff);
        color: #04131d;
        font-weight: 700;
      }
      input[type="text"], input[type="number"] {
        border: 1px solid rgba(214, 229, 255, 0.2);
        border-radius: 10px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.04);
        color: inherit;
      }
      .danger {
        color: #ffb5b5;
      }
      .hand {
        line-height: 1.8;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
      }
      .header-links {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      a {
        color: #8dd3ff;
      }
      form.inline {
        display: inline;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="stack">
        <h1>Guandan Agent Mode</h1>
        <p class="muted">
          Text-first route for browsing agents. This page auto-runs all non-player seats with the built-in legacy-v1 heuristic and only pauses when seat ${decision.batch.config.playerSeat} must act.
        </p>
        <div class="header-links">
          <a href="/">Open human table</a>
          <a href="/agent?matches=10">Start fresh 10-game batch</a>
          <a href="/agent?matches=10&amp;format=json">JSON mode</a>
        </div>
      </section>

      <section class="grid">
        <div class="stack">
          <h2>Batch Summary</h2>
          <pre>${escapeHtml(JSON.stringify(buildSummaryView(decision), null, 2))}</pre>
        </div>
        <div class="stack">
          <h2>Quick Restart</h2>
          <form action="/agent" method="get" class="stack">
            <label class="stack">
              <span>Total matches</span>
              <input type="number" min="1" max="100" name="matches" value="${decision.batch.config.totalMatches}" />
            </label>
            <label class="stack">
              <span>Base seed</span>
              <input type="number" min="0" name="seed" value="${decision.batch.config.baseSeed}" />
            </label>
            <button type="submit">Start new batch</button>
          </form>
        </div>
      </section>

      ${
        actionError
          ? `<section class="stack"><h2>Last Error</h2><p class="danger">${escapeHtml(actionError)}</p></section>`
          : ''
      }

      ${
        decision.status === 'completed'
          ? renderCompletedSection(decision)
          : renderDecisionSection(decision, escapedToken, manualActionHelp, requestUrl)
      }
    </main>
  </body>
</html>`;
}

export function buildAgentJsonResponse(params: {
  decision: AgentBatchDecision;
  token: string;
  actionError?: string | null;
  requestUrl: string;
}): Record<string, unknown> {
  const { decision, token, actionError, requestUrl } = params;
  const currentTurn = decision.turnInput;

  return {
    version: 1,
    mode: 'guandan-agent',
    requestUrl,
    actionError: actionError ?? null,
    token,
    status: decision.status,
    batch: {
      config: decision.batch.config,
      summary: decision.summary,
      completedMatches: decision.batch.completedMatches,
      currentMatchNumber: decision.currentMatchNumber,
      currentSeed: decision.batch.currentSeed,
      turnNumber: decision.turnNumber,
    },
    currentTurn: currentTurn
      ? {
          seat: currentTurn.seat,
          currentPlayer: currentTurn.currentPlayer,
          message: currentTurn.message,
          players: currentTurn.players,
          hand: currentTurn.hand.map(formatCard),
          currentTablePlay: currentTurn.currentTablePlay
            ? {
                owner: currentTurn.currentTablePlay.owner,
                label: currentTurn.currentTablePlay.play.label,
                type: currentTurn.currentTablePlay.play.type,
              }
            : null,
          legalActions: currentTurn.legalActions.map((action) => ({
            actionId: action.kind === 'pass' ? 'pass' : action.actionId,
            label: action.label,
            kind: action.kind,
            cards: action.play ? action.play.cards.map(formatCard) : [],
          })),
          finishOrder: currentTurn.finishOrder,
        }
      : null,
  };
}

function renderDecisionSection(
  decision: AgentBatchDecision,
  escapedToken: string,
  manualActionHelp: string,
  requestUrl: string,
): string {
  if (!decision.turnInput) {
    return `<section class="stack"><h2>Internal Error</h2><p class="danger">Agent mode expected a turn input but none was available.</p></section>`;
  }

  const currentTurn = decision.turnInput;
  const hand = currentTurn.hand.map(formatCard).join(' ');
  const actionRows = currentTurn.legalActions
    .map((action) => {
      const actionId = action.kind === 'pass' ? 'pass' : action.actionId;
      const detail =
        action.kind === 'pass'
          ? 'Pass this turn.'
          : `${action.label} | ${action.play?.type ?? 'play'} | ${action.play?.cards.map(formatCard).join(' ') ?? ''}`;

      return `<div class="action-row" data-action-id="${escapeHtml(actionId)}">
        <div class="action-copy">
          <strong>${escapeHtml(action.label)}</strong>
          <span class="action-id">${escapeHtml(actionId)}</span>
          <span class="muted">${escapeHtml(detail)}</span>
        </div>
        <form action="/agent" method="post">
          <input type="hidden" name="state" value="${escapedToken}" />
          <input type="hidden" name="action" value="${escapeHtml(actionId)}" />
          <button type="submit">Choose</button>
        </form>
      </div>`;
    })
    .join('');

  return `<section class="stack">
    <h2>Decision Needed</h2>
    <pre>${escapeHtml(
      JSON.stringify(
        {
          requestUrl,
          match: decision.currentMatchNumber,
          turn: decision.turnNumber,
          seat: currentTurn.seat,
          seed: decision.batch.currentSeed,
          message: currentTurn.message,
          table: currentTurn.currentTablePlay
            ? `S${currentTurn.currentTablePlay.owner} ${currentTurn.currentTablePlay.play.label}`
            : 'lead',
          remainingHandCounts: currentTurn.players.map((player) => ({
            seat: player.seat,
            handCount: player.handCount,
            finished: player.finished,
          })),
          finishOrder: currentTurn.finishOrder,
          legalActionCount: currentTurn.legalActions.length,
        },
        null,
        2,
      ),
    )}</pre>
    <div class="stack">
      <h3>Current Hand</h3>
      <p class="hand">${escapeHtml(hand)}</p>
    </div>
    <div class="stack">
      <h3>Manual Submit</h3>
      <p class="muted">Enter one of: ${escapeHtml(manualActionHelp)}</p>
      <form action="/agent" method="post" class="stack">
        <input type="hidden" name="state" value="${escapedToken}" />
        <input type="text" name="action" autocomplete="off" placeholder="pass or play:..." />
        <button type="submit">Submit action</button>
      </form>
    </div>
    <div class="stack">
      <h3>Legal Actions</h3>
      <div class="actions">${actionRows}</div>
    </div>
    <div class="stack">
      <h3>Machine-readable Turn JSON</h3>
      <pre>${escapeHtml(JSON.stringify(buildTurnView(decision), null, 2))}</pre>
    </div>
  </section>`;
}

function renderCompletedSection(decision: AgentBatchDecision): string {
  return `<section class="stack">
    <h2>Batch Complete</h2>
    <pre>${escapeHtml(JSON.stringify(buildCompletedView(decision), null, 2))}</pre>
  </section>`;
}

function buildSummaryView(decision: AgentBatchDecision): Record<string, unknown> {
  return {
    status: decision.status,
    totalMatches: decision.summary.totalMatches,
    completedMatches: decision.summary.completedMatches,
    wins: decision.summary.wins,
    losses: decision.summary.losses,
    totalSignedLevelDelta: decision.summary.totalSignedLevelDelta,
    averageSignedLevelDelta: Number(decision.summary.averageSignedLevelDelta.toFixed(3)),
    averageTurns: Number(decision.summary.averageTurns.toFixed(2)),
    placementCounts: decision.summary.placementCounts,
    currentMatchNumber: decision.currentMatchNumber,
    currentSeed: decision.batch.currentSeed,
  };
}

function buildCompletedView(decision: AgentBatchDecision): Record<string, unknown> {
  return {
    ...buildSummaryView(decision),
    completedMatches: decision.batch.completedMatches.map(formatMatchSummary),
  };
}

function buildTurnView(decision: AgentBatchDecision): Record<string, unknown> {
  const turn = decision.turnInput;
  if (!turn) {
    return {};
  }

  return {
    match: decision.currentMatchNumber,
    turn: decision.turnNumber,
    seed: decision.batch.currentSeed,
    seat: turn.seat,
    currentPlayer: turn.currentPlayer,
    message: turn.message,
    players: turn.players,
    hand: turn.hand.map(formatCard),
    currentTablePlay: turn.currentTablePlay
      ? {
          owner: turn.currentTablePlay.owner,
          label: turn.currentTablePlay.play.label,
          type: turn.currentTablePlay.play.type,
          cards: turn.currentTablePlay.play.cards.map(formatCard),
        }
      : null,
    finishOrder: turn.finishOrder,
    legalActions: turn.legalActions.map((action) => ({
      actionId: action.kind === 'pass' ? 'pass' : action.actionId,
      label: action.label,
      kind: action.kind,
      cards: action.play ? action.play.cards.map(formatCard) : [],
    })),
  };
}

function formatMatchSummary(match: AgentMatchSummary): Record<string, unknown> {
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

function formatCard(card: { rank: string; suit: keyof typeof SUIT_SYMBOLS; isWild: boolean }): string {
  const suit = SUIT_SYMBOLS[card.suit] ?? card.suit;
  const rank = getRankText(card.rank as never);
  return `${suit}${rank}${card.isWild ? '*' : ''}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

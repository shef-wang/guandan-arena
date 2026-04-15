import fs from 'node:fs';
import path from 'node:path';

import { applyArenaChosenAction, buildArenaTurnInput, createHeuristicAgent } from '../src/arena/engine';
import { createSeededRandom } from '../src/game/cards';
import { createNewGame } from '../src/game/state';
import type { ArenaActionOption, ArenaChosenAction } from '../src/arena/types';
import type { Seat } from '../src/game/types';

interface TraceEntry {
  turn: number;
  seat: Seat;
  actor: string;
  team: 0 | 1;
  action: string;
  play: {
    label: string;
    type: string;
    cards: string[];
  } | null;
  handCountAfter: number;
  tableOwnerAfter: Seat | null;
}

interface TraceFile {
  baseSeed: number | null;
  result: {
    placementKey: string;
    levelDelta: number;
    summary: string;
  } | null;
  llmTeam?: {
    team?: 0 | 1;
    seats?: Seat[];
    won?: boolean;
  };
  actionHistory?: TraceEntry[];
}

interface Divergence {
  turn: number;
  seat: Seat;
  message: string;
  table: string;
  actual: string;
  legacy: string;
  handCount: number;
  legalCount: number;
}

const tracePath = process.argv[2];

if (!tracePath) {
  throw new Error('Usage: node compareTraceAgainstLegacy.js /path/to/trace.json');
}

const resolvedTracePath = path.resolve(tracePath);
const trace = JSON.parse(fs.readFileSync(resolvedTracePath, 'utf8')) as TraceFile;
const comparedSeats = parseComparedSeats(process.argv[3], trace.llmTeam?.seats);

if (trace.baseSeed === null || trace.baseSeed === undefined) {
  throw new Error('Trace file must include baseSeed.');
}

if (!trace.actionHistory) {
  throw new Error('Trace file must include actionHistory. Re-run the match with OUTPUT_TRACE=1.');
}

const legacyAgent = createHeuristicAgent({ profile: 'legacy-v1' });
let state = createNewGame(createSeededRandom(trace.baseSeed));
const divergences: Divergence[] = [];
let comparedTurns = 0;
let matchingTurns = 0;

for (const entry of trace.actionHistory) {
  const seat = state.currentPlayer;
  if (seat !== entry.seat) {
    throw new Error(`Trace mismatch at turn ${entry.turn}: expected seat ${seat}, got seat ${entry.seat}.`);
  }

  const input = buildArenaTurnInput(state, seat);
  const actualAction = resolveActionFromTraceEntry(entry, input.legalActions);

  if (comparedSeats.includes(seat)) {
    comparedTurns += 1;
    const legacyAction = legacyAgent.decideTurn(input, { seat, state });
    if (sameAction(actualAction, legacyAction)) {
      matchingTurns += 1;
    } else {
      divergences.push({
        turn: entry.turn,
        seat,
        message: input.message,
        table: formatTable(input.currentTablePlay),
        actual: summarizeChosenAction(actualAction, input.legalActions),
        legacy: summarizeChosenAction(legacyAction, input.legalActions),
        handCount: input.hand.length,
        legalCount: input.legalActions.length,
      });
    }
  }

  state = applyArenaChosenAction(state, seat, actualAction);
}

console.log(
  JSON.stringify(
    {
      tracePath: resolvedTracePath,
      baseSeed: trace.baseSeed,
      comparedSeats,
      result: trace.result,
      comparedTurns,
      matchingTurns,
      divergenceCount: divergences.length,
      firstDivergenceTurn: divergences[0]?.turn ?? null,
      divergences,
    },
    null,
    2,
  ),
);

function parseComparedSeats(raw: string | undefined, traceSeats: Seat[] | undefined): Seat[] {
  if (raw === '1' || raw === 'odd' || raw === 'team1') {
    return [1, 3];
  }

  if (raw === '0' || raw === 'even' || raw === 'team0') {
    return [0, 2];
  }

  if (raw) {
    const parsed = raw
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((value) => value === 0 || value === 1 || value === 2 || value === 3) as Seat[];
    if (parsed.length > 0) {
      return parsed;
    }
  }

  if (traceSeats && traceSeats.length > 0) {
    return traceSeats;
  }

  return [0, 2];
}

function resolveActionFromTraceEntry(entry: TraceEntry, legalActions: ArenaActionOption[]): ArenaChosenAction {
  if (!entry.play) {
    return { kind: 'pass' };
  }

  const exact = legalActions.find((action) => {
    if (action.kind !== 'play' || !action.play) {
      return false;
    }

    return (
      action.play.type === entry.play?.type &&
      action.play.label === entry.play?.label &&
      formatCards(action.play.cards).join('|') === entry.play.cards.join('|')
    );
  });

  if (exact) {
    return { kind: 'play', actionId: exact.actionId };
  }

  const byLabel = legalActions.find(
    (action) => action.kind === 'play' && action.play?.type === entry.play?.type && action.play?.label === entry.play?.label,
  );
  if (byLabel) {
    return { kind: 'play', actionId: byLabel.actionId };
  }

  throw new Error(`Could not resolve trace action at turn ${entry.turn}: ${entry.action}`);
}

function sameAction(left: ArenaChosenAction, right: ArenaChosenAction): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'pass' && right.kind === 'pass') {
    return true;
  }

  return left.kind === 'play' && right.kind === 'play' && left.actionId === right.actionId;
}

function summarizeChosenAction(action: ArenaChosenAction, legalActions: ArenaActionOption[]): string {
  if (action.kind === 'pass') {
    return 'pass';
  }

  const matched = legalActions.find((item) => item.kind === 'play' && item.actionId === action.actionId);
  if (!matched?.play) {
    return action.actionId;
  }

  return `${matched.play.label} [${matched.play.type}]`;
}

function formatTable(
  currentTablePlay: ReturnType<typeof buildArenaTurnInput>['currentTablePlay'],
): string {
  if (!currentTablePlay) {
    return 'lead';
  }

  return `S${currentTablePlay.owner} ${currentTablePlay.play.label} [${currentTablePlay.play.type}]`;
}

function formatCards(cards: Array<{ rank: string; suit: string; isWild: boolean }>): string[] {
  return cards.map((card) => `${card.rank}-${card.suit}${card.isWild ? '*' : ''}`);
}

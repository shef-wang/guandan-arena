declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
};
declare const require: (id: string) => {
  readFileSync: (path: string, encoding: 'utf8') => string;
};

import { createSeededRandom } from '../game/cards';
import { createNewGame } from '../game/state';
import type { GameResult, GameState, Seat } from '../game/types';
import type { ArenaChosenAction } from './types';
import type { OpenRouterStatusCode, OpenRouterStatusEvent } from './openrouter';
import { createSpectatorMatch } from './spectatorMatch';
import {
  DEFAULT_GLOBAL_CONFIG,
  type SeatAgentMode,
  type SpectatorArenaConfig,
  type SpectatorSeatConfig,
} from './spectatorConfig';

const { readFileSync } = require('fs');

const SEATS = [0, 1, 2, 3] as const;
const STATUS_CODES: OpenRouterStatusCode[] = [
  'skipped',
  'requesting',
  'success',
  'request_error',
  'invalid_json',
  'repairing',
  'repair_success',
  'fallback',
];

interface SeatCounters {
  actions: number;
  plays: number;
  passes: number;
  statuses: Record<OpenRouterStatusCode, number>;
}

interface MatchSummary {
  matchIndex: number;
  seed: number | null;
  ok: boolean;
  turns: number;
  result: GameResult | null;
  seatCounters: Record<Seat, SeatCounters>;
  firstActions: Array<{
    turn: number;
    seat: Seat;
    label: string;
    actionId: string;
    model: string;
  }>;
  error?: string;
}

interface RunSummary {
  matchesRequested: number;
  matchesCompleted: number;
  matchesFailed: number;
  parallel: number;
  baseSeed: number | null;
  strictRemote: boolean;
  elapsedMs: number;
  winsByTeam: Record<0 | 1, number>;
  seats: Record<Seat, Pick<SpectatorSeatConfig, 'mode' | 'model' | 'label'>>;
  totalsBySeat: Record<Seat, SeatCounters>;
  results: MatchSummary[];
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig();
  const matches = parsePositiveInt(process.env.MATCHES, 1);
  const parallel = Math.min(matches, parsePositiveInt(process.env.PARALLEL, matches));
  const baseSeed = process.env.BASE_SEED ? Number(process.env.BASE_SEED) : null;
  const strictRemote = process.env.STRICT_REMOTE !== '0';

  const results = await runWithConcurrency(
    Array.from({ length: matches }, (_, matchIndex) => matchIndex),
    parallel,
    (matchIndex) => runOneMatch(config, matchIndex, baseSeed, strictRemote),
  );

  const completed = results.filter((result) => result.ok);
  const summary: RunSummary = {
    matchesRequested: matches,
    matchesCompleted: completed.length,
    matchesFailed: results.length - completed.length,
    parallel,
    baseSeed,
    strictRemote,
    elapsedMs: Date.now() - startedAt,
    winsByTeam: {
      0: completed.filter((result) => result.result?.winnerTeam === 0).length,
      1: completed.filter((result) => result.result?.winnerTeam === 1).length,
    },
    seats: {
      0: summarizeSeatConfig(config.seatConfigs[0]),
      1: summarizeSeatConfig(config.seatConfigs[1]),
      2: summarizeSeatConfig(config.seatConfigs[2]),
      3: summarizeSeatConfig(config.seatConfigs[3]),
    },
    totalsBySeat: mergeSeatCounters(results),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (summary.matchesFailed > 0) {
    process.exitCode = 1;
  }
}

async function runOneMatch(
  config: SpectatorArenaConfig,
  matchIndex: number,
  baseSeed: number | null,
  strictRemote: boolean,
): Promise<MatchSummary> {
  const seed = baseSeed === null ? null : baseSeed + matchIndex;
  const seatCounters = createSeatCounterMap();
  const fallbackMessages: Partial<Record<Seat, string[]>> = {};
  const statusLog: OpenRouterStatusEvent[] = [];
  const match = createSpectatorMatch(config, {
    initialState: seed === null ? undefined : createNewGame(createSeededRandom(seed)),
    onLlmStatus(event) {
      statusLog.push(event);
      if (event.seat !== undefined) {
        seatCounters[event.seat].statuses[event.code] += 1;
        if (event.code === 'fallback') {
          fallbackMessages[event.seat] = fallbackMessages[event.seat] ?? [];
          fallbackMessages[event.seat]!.push(`${event.message}${event.detail ? `\n${event.detail}` : ''}`);
        }
      }
    },
  });

  try {
    for (let turn = 0; turn < 500; turn += 1) {
      const state = match.getState();
      if (state.result) {
        return summarizeMatch(matchIndex, seed, true, state.actionHistory.length, state.result, seatCounters, state, config);
      }

      const actingSeat = state.currentPlayer;
      const fallbackCountBefore = fallbackMessages[actingSeat]?.length ?? 0;
      const step = await match.step();
      recordAction(seatCounters[step.seat], step.action);

      if (strictRemote && isRemoteSeat(config.seatConfigs[actingSeat])) {
        const fallbackCountAfter = fallbackMessages[actingSeat]?.length ?? 0;
        if (fallbackCountAfter > fallbackCountBefore) {
          const messages = fallbackMessages[actingSeat]!;
          throw new Error(`Remote fallback on seat ${actingSeat}: ${messages[messages.length - 1]}`);
        }
      }
    }

    throw new Error('Match exceeded 500 turns without a terminal result.');
  } catch (error) {
    const state = match.getState();
    return {
      ...summarizeMatch(matchIndex, seed, false, state.actionHistory.length, state.result, seatCounters, state, config),
      error: formatError(error, statusLog),
    };
  }
}

function summarizeMatch(
  matchIndex: number,
  seed: number | null,
  ok: boolean,
  turns: number,
  result: GameResult | null,
  seatCounters: Record<Seat, SeatCounters>,
  state: GameState,
  config: SpectatorArenaConfig,
): MatchSummary {
  return {
    matchIndex,
    seed,
    ok,
    turns,
    result,
    seatCounters,
    firstActions: state.actionHistory.slice(0, 16).map((entry) => ({
      turn: entry.turn,
      seat: entry.seat,
      label: entry.play?.label ?? 'pass',
      actionId: entry.play ? `play:${entry.play.key}` : 'pass',
      model: config.seatConfigs[entry.seat].model || config.seatConfigs[entry.seat].mode,
    })),
  };
}

function loadConfig(): SpectatorArenaConfig {
  const raw = process.env.SPECTATOR_CONFIG_JSON ?? readConfigPath();
  if (!raw) {
    throw new Error('Provide SPECTATOR_CONFIG_JSON or SPECTATOR_CONFIG_PATH.');
  }

  const parsed = JSON.parse(raw) as SpectatorArenaConfig;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  return {
    globalConfig: {
      ...DEFAULT_GLOBAL_CONFIG,
      ...parsed.globalConfig,
      apiKey: parsed.globalConfig?.apiKey?.trim() || apiKey || '',
    },
    seatConfigs: {
      0: normalizeSeatConfig(parsed.seatConfigs[0]),
      1: normalizeSeatConfig(parsed.seatConfigs[1]),
      2: normalizeSeatConfig(parsed.seatConfigs[2]),
      3: normalizeSeatConfig(parsed.seatConfigs[3]),
    },
  };
}

function readConfigPath(): string | null {
  const pathArg = process.argv.find((arg) => arg.startsWith('--config='));
  const configPath = process.env.SPECTATOR_CONFIG_PATH ?? pathArg?.slice('--config='.length);
  if (!configPath) {
    return null;
  }

  return readFileSync(configPath, 'utf8');
}

function normalizeSeatConfig(config: SpectatorSeatConfig): SpectatorSeatConfig {
  return {
    mode: config.mode,
    label: config.label ?? '',
    model: config.model ?? '',
    apiKey: config.apiKey ?? '',
  };
}

function createSeatCounterMap(): Record<Seat, SeatCounters> {
  return {
    0: createSeatCounters(),
    1: createSeatCounters(),
    2: createSeatCounters(),
    3: createSeatCounters(),
  };
}

function createSeatCounters(): SeatCounters {
  const statuses = Object.fromEntries(STATUS_CODES.map((code) => [code, 0])) as Record<OpenRouterStatusCode, number>;
  return {
    actions: 0,
    plays: 0,
    passes: 0,
    statuses,
  };
}

function recordAction(counter: SeatCounters, action: ArenaChosenAction): void {
  counter.actions += 1;
  if (action.kind === 'pass') {
    counter.passes += 1;
  } else {
    counter.plays += 1;
  }
}

function mergeSeatCounters(results: MatchSummary[]): Record<Seat, SeatCounters> {
  const totals = createSeatCounterMap();
  for (const result of results) {
    for (const seat of SEATS) {
      totals[seat].actions += result.seatCounters[seat].actions;
      totals[seat].plays += result.seatCounters[seat].plays;
      totals[seat].passes += result.seatCounters[seat].passes;
      for (const code of STATUS_CODES) {
        totals[seat].statuses[code] += result.seatCounters[seat].statuses[code];
      }
    }
  }
  return totals;
}

function isRemoteSeat(config: SpectatorSeatConfig): boolean {
  return config.mode === 'openrouter';
}

function summarizeSeatConfig(config: SpectatorSeatConfig): Pick<SpectatorSeatConfig, 'mode' | 'model' | 'label'> {
  return {
    mode: config.mode,
    model: config.model,
    label: config.label,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return results;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatError(error: unknown, statusLog: OpenRouterStatusEvent[]): string {
  const message = error instanceof Error ? error.message : String(error);
  const recent = statusLog.slice(-6).map((event) => `${event.seat ?? '?'}:${event.code}:${event.message}`);
  return [message, recent.length > 0 ? `Recent remote statuses: ${recent.join(' | ')}` : null].filter(Boolean).join('\n');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { createHeuristicAgent, createFunctionAgent, GuandanArenaMatch } from './engine';
import { createOpenRouterAgent } from './openrouter';
import type { AiProfile } from '../game/ai';
import { createSeededRandom } from '../game/cards';
import { createNewGame } from '../game/state';
import type { GuandanArenaAgent } from './types';
import type { Seat, Team } from '../game/types';
import type { OpenRouterStatusEvent } from './openrouter';

interface UsageAccumulator {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface OpenRouterTeamConfig {
  team: Team;
  seats: [Seat, Seat];
}

interface RemoteDiagnostics {
  requestsStarted: number;
  requestErrors: number;
  invalidReplies: number;
  repairsAttempted: number;
  repairSuccesses: number;
  successfulActions: number;
  fallbacks: number;
  skippedDecisions: number;
  sampleErrors: string[];
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4.1-nano';
const ALL_SEATS = [0, 1, 2, 3] as const;

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const baseUrl = process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const opponentProfile = parseOpponentProfile(process.env.OPENROUTER_OPPONENT_PROFILE);
  const opponentLabel = getOpponentLabel(opponentProfile);
  const llmTeam = parseOpenRouterTeam(process.env.OPENROUTER_TEAM);
  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS ?? '15000');
  const maxTokens = Number(process.env.OPENROUTER_MAX_TOKENS ?? '96');
  const strictRemote = process.env.OPENROUTER_STRICT_REMOTE === '1';
  const matches = Number(process.env.MATCHES ?? '1');
  const baseSeed = process.env.BASE_SEED ? Number(process.env.BASE_SEED) : null;
  const usageBySeat: Record<Seat, UsageAccumulator> = {
    0: createUsageAccumulator(),
    1: createUsageAccumulator(),
    2: createUsageAccumulator(),
    3: createUsageAccumulator(),
  };
  const diagnosticsBySeat: Record<Seat, RemoteDiagnostics> = {
    0: createRemoteDiagnostics(),
    1: createRemoteDiagnostics(),
    2: createRemoteDiagnostics(),
    3: createRemoteDiagnostics(),
  };
  const includeTrace = process.env.OUTPUT_TRACE === '1';
  const results: Array<{
    matchIndex: number;
    seed: number | null;
    turns: number;
    won: boolean;
    placementKey: string | null;
    levelDelta: number | null;
  }> = [];
  let llmWins = 0;
  let legacyWins = 0;
  let llmLevelGain = 0;
  let legacyLevelGain = 0;
  let lastResultState: Awaited<ReturnType<GuandanArenaMatch['runUntilFinished']>> | null = null;

  for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
    const seed = baseSeed === null ? null : baseSeed + matchIndex;
    const match = new GuandanArenaMatch({
      initialState: seed === null ? undefined : createNewGame(createSeededRandom(seed)),
      agents: [
        createMatchAgentForSeat(0, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          usageBySeat,
        }),
        createMatchAgentForSeat(1, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          usageBySeat,
        }),
        createMatchAgentForSeat(2, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          usageBySeat,
        }),
        createMatchAgentForSeat(3, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          usageBySeat,
        }),
      ],
    });

    const resultState = await match.runUntilFinished({ maxTurns: 500 });
    lastResultState = resultState;

    const won = resultState.result?.winnerTeam === llmTeam.team;
    if (won) {
      llmWins += 1;
      llmLevelGain += resultState.result?.levelDelta ?? 0;
    } else {
      legacyWins += 1;
      legacyLevelGain += resultState.result?.levelDelta ?? 0;
    }

    results.push({
      matchIndex,
      seed,
      turns: resultState.actionHistory.length,
      won,
      placementKey: resultState.result?.placementKey ?? null,
      levelDelta: resultState.result?.levelDelta ?? null,
    });
  }

  if (!lastResultState) {
    throw new Error('No matches were run.');
  }

  const totalUsage = ALL_SEATS.reduce<UsageAccumulator>((current, seat) => mergeUsage(current, usageBySeat[seat]), createUsageAccumulator());
  const totalDiagnostics = ALL_SEATS.reduce<RemoteDiagnostics>(
    (current, seat) => mergeRemoteDiagnostics(current, diagnosticsBySeat[seat]),
    createRemoteDiagnostics(),
  );

  console.log(
    JSON.stringify(
      {
        model,
        opponentProfile,
        matches,
        baseSeed,
        strictRemote,
        summary: {
          llmWins,
          legacyWins,
          llmWinRate: matches > 0 ? llmWins / matches : 0,
          llmAverageLevelGainOnWins: llmWins > 0 ? llmLevelGain / llmWins : 0,
          legacyAverageLevelGainOnWins: legacyWins > 0 ? legacyLevelGain / legacyWins : 0,
        },
        timeoutMs,
        maxTokens,
        turns: lastResultState.actionHistory.length,
        finishOrder: lastResultState.finishOrder.map((seat) => ({
          seat,
          name: lastResultState.players[seat].name,
          team: lastResultState.players[seat].team,
        })),
        result: lastResultState.result,
        llmTeam: {
          team: llmTeam.team,
          seats: llmTeam.seats,
          won: lastResultState.result?.winnerTeam === llmTeam.team,
        },
        usage: {
          seat0: usageBySeat[0],
          seat1: usageBySeat[1],
          seat2: usageBySeat[2],
          seat3: usageBySeat[3],
          total: totalUsage,
        },
        diagnostics: {
          seat0: diagnosticsBySeat[0],
          seat1: diagnosticsBySeat[1],
          seat2: diagnosticsBySeat[2],
          seat3: diagnosticsBySeat[3],
          total: totalDiagnostics,
        },
        matchResults: results,
        actionHistory: includeTrace
          ? lastResultState.actionHistory.map((entry) => ({
              turn: entry.turn,
              seat: entry.seat,
              actor: lastResultState.players[entry.seat].name,
              team: lastResultState.players[entry.seat].team,
              action: entry.action,
              actionId: entry.play ? `play:${entry.play.key}` : 'pass',
              play: entry.play
                ? {
                    key: entry.play.key,
                    label: entry.play.label,
                    type: entry.play.type,
                    cards: entry.play.cards.map((card) => `${card.rank}-${card.suit}${card.isWild ? '*' : ''}`),
                  }
                : null,
              handCountAfter: entry.handCountAfter,
              tableOwnerAfter: entry.tableOwnerAfter,
            }))
          : undefined,
      },
      null,
      2,
    ),
  );
}

function parseOpenRouterTeam(raw: string | undefined): OpenRouterTeamConfig {
  if (raw === '1' || raw === 'odd' || raw === 'team1') {
    return {
      team: 1,
      seats: [1, 3],
    };
  }

  return {
    team: 0,
    seats: [0, 2],
  };
}

function parseOpponentProfile(raw: string | undefined): AiProfile {
  if (raw === 'baseline' || raw === 'legacy-v1' || raw === 'legacy-vR' || raw === 'balanced-v2') {
    return raw;
  }

  if (raw && /^legacy-v2\.\d+$/.test(raw)) {
    return raw as AiProfile;
  }

  if (raw && /^legacy-v3\.\d+$/.test(raw)) {
    return raw as AiProfile;
  }

  return 'balanced-v2';
}

function getOpponentLabel(profile: AiProfile): string {
  if (profile === 'legacy-v1') {
    return 'Legacy';
  }
  if (profile.startsWith('legacy-v2.')) {
    return `Legacy ${profile.replace('legacy-', '')}`;
  }
  if (profile.startsWith('legacy-v3.')) {
    return `Legacy ${profile.replace('legacy-', '')}`;
  }
  if (profile === 'legacy-vR') {
    return 'Legacy vR';
  }
  if (profile === 'baseline') {
    return 'Baseline';
  }
  return 'Balanced';
}

function createMatchAgentForSeat(
  seat: Seat,
  llmTeam: OpenRouterTeamConfig,
  config: {
    apiKey: string;
    baseUrl: string;
    matchIndex: number;
    model: string;
    opponentLabel: string;
    opponentProfile: AiProfile;
    strictRemote: boolean;
    timeoutMs: number;
    maxTokens: number;
    diagnosticsBySeat: Record<Seat, RemoteDiagnostics>;
    usageBySeat: Record<Seat, UsageAccumulator>;
  },
): GuandanArenaAgent {
  if (llmTeam.seats.includes(seat)) {
    return createTrackedOpenRouterAgent({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      label: `Seat ${seat} LLM`,
      model: config.model,
      seat,
      strictRemote: config.strictRemote,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      diagnostics: config.diagnosticsBySeat[seat],
      usage: config.usageBySeat[seat],
    });
  }

  return createHeuristicAgent({
    id: `builtin-${config.opponentProfile}-${config.matchIndex}-seat-${seat}`,
    label: `Seat ${seat} ${config.opponentLabel}`,
    profile: config.opponentProfile,
  });
}

function createTrackedOpenRouterAgent(config: {
  seat: Seat;
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  strictRemote: boolean;
  timeoutMs: number;
  maxTokens: number;
  diagnostics: RemoteDiagnostics;
  usage: UsageAccumulator;
}): GuandanArenaAgent {
  const turnFailures: string[] = [];
  const agent = createOpenRouterAgent({
    id: `openrouter-seat-${config.seat}`,
    label: config.label,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    seat: config.seat,
    temperature: 0,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    onStatus(event) {
      recordStatusEvent(config.diagnostics, event);
      estimateUsageFromStatus(config.usage, event);
      if (event.code === 'fallback') {
        turnFailures.push(event.message);
      }
    },
  });

  return createFunctionAgent({
    id: agent.id,
    label: agent.label,
    agentType: 'openrouter',
    async decideTurn(input, context) {
      turnFailures.length = 0;
      const action = await agent.decideTurn(input, context);
      if (config.strictRemote && turnFailures.length > 0) {
        throw new Error(`Strict remote mode blocked fallback: ${turnFailures[0]}`);
      }
      return action;
    },
  });
}

function estimateUsageFromStatus(target: UsageAccumulator, event: OpenRouterStatusEvent): void {
  if (event.code === 'requesting') {
    target.requests += 1;
    target.promptTokens += estimateTokens(event.message);
  }
  if (event.code === 'success' || event.code === 'repair_success') {
    target.completionTokens += estimateTokens(event.message);
    target.totalTokens = target.promptTokens + target.completionTokens;
  }
}

function createUsageAccumulator(): UsageAccumulator {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function mergeUsage(left: UsageAccumulator, right: UsageAccumulator): UsageAccumulator {
  return {
    requests: left.requests + right.requests,
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function createRemoteDiagnostics(): RemoteDiagnostics {
  return {
    requestsStarted: 0,
    requestErrors: 0,
    invalidReplies: 0,
    repairsAttempted: 0,
    repairSuccesses: 0,
    successfulActions: 0,
    fallbacks: 0,
    skippedDecisions: 0,
    sampleErrors: [],
  };
}

function mergeRemoteDiagnostics(left: RemoteDiagnostics, right: RemoteDiagnostics): RemoteDiagnostics {
  return {
    requestsStarted: left.requestsStarted + right.requestsStarted,
    requestErrors: left.requestErrors + right.requestErrors,
    invalidReplies: left.invalidReplies + right.invalidReplies,
    repairsAttempted: left.repairsAttempted + right.repairsAttempted,
    repairSuccesses: left.repairSuccesses + right.repairSuccesses,
    successfulActions: left.successfulActions + right.successfulActions,
    fallbacks: left.fallbacks + right.fallbacks,
    skippedDecisions: left.skippedDecisions + right.skippedDecisions,
    sampleErrors: [...left.sampleErrors, ...right.sampleErrors].slice(0, 12),
  };
}

function recordStatusEvent(target: RemoteDiagnostics, event: OpenRouterStatusEvent): void {
  if (event.code === 'requesting') {
    target.requestsStarted += 1;
    return;
  }

  if (event.code === 'success') {
    target.successfulActions += 1;
    return;
  }

  if (event.code === 'invalid_json') {
    target.invalidReplies += 1;
    addDiagnosticSample(target, `${event.message}${event.detail ? `\n${truncate(event.detail)}` : ''}`);
    return;
  }

  if (event.code === 'repairing') {
    target.repairsAttempted += 1;
    return;
  }

  if (event.code === 'repair_success') {
    target.repairSuccesses += 1;
    target.successfulActions += 1;
    return;
  }

  if (event.code === 'request_error') {
    target.requestErrors += 1;
    addDiagnosticSample(target, `${event.message}${event.detail ? `\n${truncate(event.detail)}` : ''}`);
    return;
  }

  if (event.code === 'fallback') {
    target.fallbacks += 1;
    addDiagnosticSample(target, `${event.message}${event.detail ? `\n${truncate(event.detail)}` : ''}`);
    return;
  }

  if (event.code === 'skipped') {
    target.skippedDecisions += 1;
  }
}

function addDiagnosticSample(target: RemoteDiagnostics, message: string): void {
  if (target.sampleErrors.length >= 6) {
    return;
  }

  target.sampleErrors.push(message);
}

function truncate(text: string, maxLength: number = 320): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(message);
  process.exitCode = 1;
});

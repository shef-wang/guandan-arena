declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { createHeuristicAgent, createFunctionAgent, GuandanArenaMatch, parseArenaChosenAction } from './engine';
import { createOpenRouterRerankerAgent, OPENROUTER_DEFAULT_RERANKER_MODEL } from './openrouter';
import { createDeviationMetric, mergeDeviationMetric, recordDeviationMetric, summarizeDeviationMetric, type DeviationMetric } from './deviationMetric';
import { formatArenaLlmSystemPrompt, formatTurnInputAsPrompt } from './prompt';
import type { AiProfile } from '../game/ai';
import { createSeededRandom } from '../game/cards';
import { createNewGame } from '../game/state';
import type { ArenaChosenAction, GuandanArenaAgent } from './types';
import type { Seat, Team } from '../game/types';
import type { OpenRouterStatusEvent } from './openrouter';

interface OpenRouterResponse {
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string; content?: string }>;
      reasoning?: string;
    };
  }>;
}

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

type OpenRouterAgentMode = 'openrouter' | 'llmreranker';

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
  const agentMode = parseOpenRouterAgentMode(process.env.OPENROUTER_AGENT_MODE);
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
  const deviationMetricBySeat: Record<Seat, DeviationMetric> = {
    0: createDeviationMetric(),
    1: createDeviationMetric(),
    2: createDeviationMetric(),
    3: createDeviationMetric(),
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
          agentMode,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          deviationMetricBySeat,
          usageBySeat,
        }),
        createMatchAgentForSeat(1, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          agentMode,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          deviationMetricBySeat,
          usageBySeat,
        }),
        createMatchAgentForSeat(2, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          agentMode,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          deviationMetricBySeat,
          usageBySeat,
        }),
        createMatchAgentForSeat(3, llmTeam, {
          apiKey,
          baseUrl,
          matchIndex,
          model,
          agentMode,
          opponentLabel,
          opponentProfile,
          strictRemote,
          timeoutMs,
          maxTokens,
          diagnosticsBySeat,
          deviationMetricBySeat,
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
  const totalDeviationMetric = ALL_SEATS.reduce<DeviationMetric>(
    (current, seat) => mergeDeviationMetric(current, deviationMetricBySeat[seat]),
    createDeviationMetric(),
  );

  console.log(
    JSON.stringify(
      {
        model,
        agentMode,
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
        deviation_metric:
          agentMode === 'llmreranker'
            ? {
                seat0: summarizeDeviationMetric(deviationMetricBySeat[0]),
                seat1: summarizeDeviationMetric(deviationMetricBySeat[1]),
                seat2: summarizeDeviationMetric(deviationMetricBySeat[2]),
                seat3: summarizeDeviationMetric(deviationMetricBySeat[3]),
                total: summarizeDeviationMetric(totalDeviationMetric),
              }
            : null,
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

function parseOpenRouterAgentMode(raw: string | undefined): OpenRouterAgentMode {
  if (raw === 'llmreranker') {
    return 'llmreranker';
  }

  return 'openrouter';
}

function parseOpponentProfile(raw: string | undefined): AiProfile {
  if (raw === 'baseline' || raw === 'legacy-v1' || raw === 'legacy-vR' || raw === 'balanced-v2') {
    return raw;
  }

  return 'balanced-v2';
}

function getOpponentLabel(profile: AiProfile): string {
  if (profile === 'legacy-v1') {
    return 'Legacy';
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
    agentMode: OpenRouterAgentMode;
    opponentLabel: string;
    opponentProfile: AiProfile;
    strictRemote: boolean;
    timeoutMs: number;
    maxTokens: number;
    diagnosticsBySeat: Record<Seat, RemoteDiagnostics>;
    deviationMetricBySeat: Record<Seat, DeviationMetric>;
    usageBySeat: Record<Seat, UsageAccumulator>;
  },
): GuandanArenaAgent {
  if (llmTeam.seats.includes(seat)) {
    if (config.agentMode === 'llmreranker') {
      const diagnostics = config.diagnosticsBySeat[seat];
      const turnFailures: string[] = [];
      const rerankerAgent = createOpenRouterRerankerAgent({
        id: `llmreranker-seat-${seat}`,
        label: `Seat ${seat} LLM Reranker`,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model || OPENROUTER_DEFAULT_RERANKER_MODEL,
        seat,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        onRerankDecision(event) {
          recordDeviationMetric(config.deviationMetricBySeat[seat], event);
        },
        onStatus(event) {
          recordStatusEvent(diagnostics, event);
          if (event.code === 'fallback') {
            turnFailures.push(event.message);
          }
        },
      });

      return createFunctionAgent({
        id: `llmreranker-headless-seat-${seat}`,
        label: `Seat ${seat} LLM Reranker`,
        async decideTurn(input, context) {
          turnFailures.length = 0;
          const action = await rerankerAgent.decideTurn(input, context);
          if (config.strictRemote && turnFailures.length > 0) {
            throw new Error(`Strict remote mode blocked fallback: ${turnFailures[0]}`);
          }

          return action;
        },
      });
    }

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
  return createFunctionAgent({
    id: `openrouter-seat-${config.seat}`,
    label: config.label,
    async decideTurn(input) {
      const systemPrompt = formatArenaLlmSystemPrompt(input);
      const prompt = formatTurnInputAsPrompt(input);
      return await requestValidAction(config, systemPrompt, prompt, input.legalActions);
    },
  });
}

async function requestValidAction(
  config: {
    label: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    strictRemote: boolean;
    timeoutMs: number;
    maxTokens: number;
    diagnostics: RemoteDiagnostics;
    usage: UsageAccumulator;
  },
  systemPrompt: string,
  prompt: string,
  legalActions: Parameters<typeof parseArenaChosenAction>[1],
): Promise<ArenaChosenAction> {
  try {
    const firstAttempt = await requestOpenRouterCompletion(config, systemPrompt, prompt);
    try {
      const action = parseArenaChosenAction(firstAttempt.raw, legalActions);
      config.diagnostics.successfulActions += 1;
      return action;
    } catch (error) {
      config.diagnostics.invalidReplies += 1;
      addDiagnosticSample(config.diagnostics, `Invalid primary reply: ${getErrorMessage(error)}\nRaw reply:\n${truncate(firstAttempt.raw)}`);
      const repairMessage = error instanceof Error ? error.message : 'Invalid action';
      const repairPrompt = buildRepairPrompt(legalActions, repairMessage);
      config.diagnostics.repairsAttempted += 1;
      try {
        const secondAttempt = await requestOpenRouterCompletion(config, systemPrompt, repairPrompt);
        const repairedAction = parseArenaChosenAction(secondAttempt.raw, legalActions);
        config.diagnostics.repairSuccesses += 1;
        config.diagnostics.successfulActions += 1;
        return repairedAction;
      } catch (repairError) {
        config.diagnostics.fallbacks += 1;
        addDiagnosticSample(
          config.diagnostics,
          `Repair failed: ${getErrorMessage(repairError)}\nFallback action: ${JSON.stringify(chooseFallbackAction(legalActions))}`,
        );
        if (config.strictRemote) {
          throw new Error(`Strict remote mode blocked fallback after invalid reply: ${getErrorMessage(repairError)}`);
        }

        return chooseFallbackAction(legalActions);
      }
    }
  } catch (requestError) {
    if (config.strictRemote && requestError instanceof Error && requestError.message.startsWith('Strict remote mode')) {
      throw requestError;
    }

    config.diagnostics.requestErrors += 1;
    config.diagnostics.fallbacks += 1;
    addDiagnosticSample(config.diagnostics, `Request failed before valid action: ${getErrorMessage(requestError)}`);
    if (config.strictRemote) {
      throw new Error(`Strict remote mode blocked fallback after request failure: ${getErrorMessage(requestError)}`);
    }

    return chooseFallbackAction(legalActions);
  }
}

async function requestOpenRouterCompletion(
  config: {
    label: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxTokens: number;
    diagnostics: RemoteDiagnostics;
    usage: UsageAccumulator;
  },
  systemPrompt: string,
  prompt: string,
): Promise<{ raw: string }> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), config.timeoutMs);
  config.diagnostics.requestsStarted += 1;
  const response = await fetch(config.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: config.maxTokens,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
    signal: controller.signal,
  });

  try {
    const data = (await response.json()) as OpenRouterResponse;
    if (!response.ok) {
      accumulateUsage(config.usage, data, prompt, '');
      throw new Error(data.error?.message ?? `OpenRouter request failed with status ${response.status}`);
    }

    const raw = extractText(data);
    accumulateUsage(config.usage, data, prompt, raw);
    if (!raw) {
      throw new Error('OpenRouter returned empty content.');
    }

    return { raw };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function extractText(data: OpenRouterResponse): string {
  const content = data.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text ?? item.content ?? '')
      .join('')
      .trim();
  }

  const reasoning = data.choices?.[0]?.message?.reasoning;
  if (reasoning) {
    return extractJSONObject(reasoning);
  }

  return '';
}

function extractJSONObject(raw: string): string {
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return '';
  }
  return raw.slice(firstBrace, lastBrace + 1).trim();
}

function buildRepairPrompt(
  legalActions: Parameters<typeof parseArenaChosenAction>[1],
  repairMessage: string,
): string {
  const allowedOutputs = (legalActions ?? []).map((action) =>
    action.kind === 'pass' ? '{"kind":"pass"}' : `{"kind":"play","actionId":"${action.actionId}"}`,
  );
  return [
    `Previous reply invalid: ${repairMessage}`,
    'Reply with exactly one JSON object and nothing else.',
    'Allowed outputs:',
    ...allowedOutputs,
  ].join('\n');
}

function chooseFallbackAction(legalActions: Parameters<typeof parseArenaChosenAction>[1]): ArenaChosenAction {
  const firstPlay = legalActions?.find((action) => action.kind === 'play');
  if (firstPlay) {
    return {
      kind: 'play',
      actionId: firstPlay.actionId,
    };
  }

  if (legalActions?.some((action) => action.kind === 'pass')) {
    return { kind: 'pass' };
  }

  throw new Error('No legal actions available for fallback.');
}

function accumulateUsage(target: UsageAccumulator, data: OpenRouterResponse, prompt: string, raw: string): void {
  target.requests += 1;
  target.promptTokens += data.usage?.prompt_tokens ?? estimateTokens(prompt);
  target.completionTokens += data.usage?.completion_tokens ?? estimateTokens(raw);
  target.totalTokens += data.usage?.total_tokens ?? estimateTokens(prompt) + estimateTokens(raw);
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
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

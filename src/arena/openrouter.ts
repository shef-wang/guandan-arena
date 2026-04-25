import type { Seat } from '../game/types';
import { chooseAiAction, rankLegacyV1ActionCandidates } from '../game/ai';
import { parseArenaChosenAction } from './engine';
import { formatArenaLlmSystemPrompt, formatTurnInputAsPrompt } from './prompt';
import type { ArenaActionOption, ArenaChosenAction, ArenaTurnInput, GuandanArenaAgent } from './types';

export interface OpenRouterAgentConfig {
  id: string;
  label: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  seat?: Seat;
  onStatus?: (event: OpenRouterStatusEvent) => void;
  onRerankDecision?: (event: OpenRouterRerankDecisionEvent) => void;
}

export type OpenRouterAgentMode = 'openrouter' | 'llmreranker';
export type OpenRouterStatusLevel = 'info' | 'success' | 'warn' | 'error';
export type OpenRouterStatusCode =
  | 'skipped'
  | 'requesting'
  | 'success'
  | 'request_error'
  | 'invalid_json'
  | 'repairing'
  | 'repair_success'
  | 'fallback';

export interface OpenRouterStatusEvent {
  agentId: string;
  agentLabel: string;
  seat?: Seat;
  mode: OpenRouterAgentMode;
  model: string;
  level: OpenRouterStatusLevel;
  code: OpenRouterStatusCode;
  message: string;
  detail?: string;
  timestamp: number;
}

export interface OpenRouterRerankDecisionEvent {
  agentId: string;
  agentLabel: string;
  seat?: Seat;
  model: string;
  timestamp: number;
  skipped: boolean;
  candidateCount: number;
  chosenAction: ArenaChosenAction;
  fallbackAction: ArenaChosenAction;
  chosenLegacyRank: number | null;
  fallbackLegacyRank: number | null;
  deviatedFromLegacyTop: boolean;
  deviatedFromLegacyFallback: boolean;
}

interface OpenRouterResponse {
  error?: {
    message?: string;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string; content?: string }>;
      reasoning?: string;
    };
  }>;
}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_RERANKER_MODEL = 'deepseek/deepseek-chat-v3-0324';
const DEFAULT_MAX_TOKENS = 96;
const KIMI_K26_MODEL = 'moonshotai/kimi-k2.6';
const KIMI_K26_MAX_TOKENS = 512;
const KIMI_K26_TIMEOUT_MS = 90_000;
const DEFAULT_RERANKER_TOP_K = 6;

interface RerankerCandidate {
  key: string;
  action: ArenaChosenAction;
  option: ArenaActionOption | null;
  legacyRank: number;
  legacyScore: number;
  isFallback: boolean;
}

export function createOpenRouterAgent(config: OpenRouterAgentConfig): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    agentType: 'openrouter',
    async decideTurn(input) {
      const systemPrompt = formatArenaLlmSystemPrompt(input);
      const basePrompt = formatTurnInputAsPrompt(input);
      const legalActions = input.legalActions;
      const fallback = chooseFallbackAction(legalActions);

      return decideWithRepair({
        mode: 'openrouter',
        requestConfig: config,
        systemPrompt,
        prompt: basePrompt,
        requestMessage: 'Calling model for action selection.',
        buildRepairPrompt: (errorMessage) => buildRepairPrompt(basePrompt, legalActions, errorMessage),
        parseAction: (raw) => parseArenaChosenAction(raw, legalActions),
        fallbackAction: fallback,
        fallbackReasonLabel: 'Repair failed, using builtin legal fallback.',
      });
    },
  };
}

export function createOpenRouterRerankerAgent(
  config: OpenRouterAgentConfig & {
    topK?: number;
  },
): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    agentType: 'llmreranker',
    async decideTurn(input, context) {
      const requestConfig: OpenRouterAgentConfig = {
        ...config,
        model: config.model.trim() || OPENROUTER_DEFAULT_RERANKER_MODEL,
      };
      const fallback = toArenaChosenAction(chooseAiAction(context.state, context.seat, 'legacy-v1'));
      const candidates = buildRerankerCandidates(context.state, input, fallback, config.topK ?? DEFAULT_RERANKER_TOP_K);
      const fallbackCandidate = candidates.find((candidate) => candidate.isFallback) ?? null;

      if (candidates.length <= 1 || input.legalActions.length <= 2 || (fallback.kind === 'pass' && candidates.length <= 2)) {
        emitStatus(requestConfig, 'llmreranker', {
          code: 'skipped',
          level: 'info',
          message: 'Skipped LLM rerank for a trivial position; kept legacy-v1 fallback.',
          detail: [
            `fallback=${formatChosenAction(fallback)}`,
            `candidates=${candidates.length}`,
            `legalActions=${input.legalActions.length}`,
          ].join('\n'),
        });
        emitRerankDecision(requestConfig, {
          skipped: true,
          candidateCount: candidates.length,
          chosenAction: fallback,
          fallbackAction: fallback,
          chosenLegacyRank: fallbackCandidate?.legacyRank ?? null,
          fallbackLegacyRank: fallbackCandidate?.legacyRank ?? null,
        });
        return fallback;
      }

      const systemPrompt = [
        formatArenaLlmSystemPrompt(input),
        'You are not generating legal actions from scratch.',
        'You are reranking a shortlist of candidate actions produced by a legacy heuristic.',
        'You may choose ONLY from the candidate actions provided below.',
        'Keep the legacy fallback unless team-level context clearly favors another candidate.',
      ].join(' ');
      const prompt = buildRerankerPrompt(input, candidates);

      const action = await decideWithRepair({
        mode: 'llmreranker',
        requestConfig,
        systemPrompt,
        prompt,
        requestMessage: `Calling model to rerank ${candidates.length} legacy candidates.`,
        buildRepairPrompt: (errorMessage) => buildCandidateRepairPrompt(candidates, errorMessage),
        parseAction: (raw) => validateRerankerAction(parseArenaChosenAction(raw), candidates),
        fallbackAction: fallback,
        fallbackReasonLabel: 'Repair failed, falling back to legacy-v1.',
      });

      const chosenCandidate = candidates.find((candidate) => candidate.key === actionKey(action)) ?? null;
      emitRerankDecision(requestConfig, {
        skipped: false,
        candidateCount: candidates.length,
        chosenAction: action,
        fallbackAction: fallback,
        chosenLegacyRank: chosenCandidate?.legacyRank ?? null,
        fallbackLegacyRank: fallbackCandidate?.legacyRank ?? null,
      });

      return action;
    },
  };
}

interface OpenRouterDecisionFlowConfig {
  mode: OpenRouterAgentMode;
  requestConfig: OpenRouterAgentConfig;
  systemPrompt: string;
  prompt: string;
  requestMessage: string;
  buildRepairPrompt: (errorMessage: string) => string;
  parseAction: (raw: string) => ArenaChosenAction;
  fallbackAction: ArenaChosenAction;
  fallbackReasonLabel: string;
}

async function decideWithRepair(config: OpenRouterDecisionFlowConfig): Promise<ArenaChosenAction> {
  emitStatus(config.requestConfig, config.mode, {
    code: 'requesting',
    level: 'info',
    message: config.requestMessage,
  });

  try {
    const firstRaw = await requestOpenRouterText(config.requestConfig, config.systemPrompt, config.prompt);

    try {
      const action = config.parseAction(firstRaw);
      emitStatus(config.requestConfig, config.mode, {
        code: 'success',
        level: 'success',
        message: `Model reply accepted: ${formatChosenAction(action)}.`,
      });
      return action;
    } catch (firstParseError) {
      const firstErrorMessage = getErrorMessage(firstParseError);
      const invalidDetail = formatInvalidReplyDetail(firstParseError, firstRaw);

      emitStatus(config.requestConfig, config.mode, {
        code: 'invalid_json',
        level: 'warn',
        message: 'Primary reply was not valid legal JSON; requesting strict repair.',
        detail: invalidDetail,
      });

      return requestRepair(config, firstErrorMessage, invalidDetail);
    }
  } catch (firstRequestError) {
    const firstErrorMessage = getErrorMessage(firstRequestError);
    const requestDetail = `Primary request error: ${firstErrorMessage}`;

    emitStatus(config.requestConfig, config.mode, {
      code: 'request_error',
      level: 'warn',
      message: 'Primary request failed; retrying once with a strict JSON prompt.',
      detail: requestDetail,
    });

    return requestRepair(config, firstErrorMessage, requestDetail);
  }
}

async function requestRepair(
  config: OpenRouterDecisionFlowConfig,
  firstErrorMessage: string,
  firstFailureDetail: string,
): Promise<ArenaChosenAction> {
  emitStatus(config.requestConfig, config.mode, {
    code: 'repairing',
    level: 'info',
    message: 'Sending repair request with constrained legal JSON outputs.',
  });

  try {
    const secondRaw = await requestOpenRouterText(
      config.requestConfig,
      config.systemPrompt,
      config.buildRepairPrompt(firstErrorMessage),
    );

    try {
      const repairedAction = config.parseAction(secondRaw);
      emitStatus(config.requestConfig, config.mode, {
        code: 'repair_success',
        level: 'warn',
        message: `Repair reply accepted: ${formatChosenAction(repairedAction)}.`,
        detail: firstFailureDetail,
      });
      return repairedAction;
    } catch (secondParseError) {
      const fallbackDetail = joinStatusDetails(
        firstFailureDetail,
        `Repair parse error: ${getErrorMessage(secondParseError)}`,
        `Repair raw reply:\n${truncateForStatus(secondRaw)}`,
      );

      emitStatus(config.requestConfig, config.mode, {
        code: 'fallback',
        level: 'error',
        message: `${config.fallbackReasonLabel} ${formatChosenAction(config.fallbackAction)}.`,
        detail: fallbackDetail,
      });
      return config.fallbackAction;
    }
  } catch (secondRequestError) {
    const fallbackDetail = joinStatusDetails(
      firstFailureDetail,
      `Repair request error: ${getErrorMessage(secondRequestError)}`,
    );

    emitStatus(config.requestConfig, config.mode, {
      code: 'fallback',
      level: 'error',
      message: `${config.fallbackReasonLabel} ${formatChosenAction(config.fallbackAction)}.`,
      detail: fallbackDetail,
    });
    return config.fallbackAction;
  }
}

function buildHeaders(config: OpenRouterAgentConfig): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.siteUrl) {
    headers['HTTP-Referer'] = config.siteUrl;
  }

  if (config.siteName) {
    headers['X-Title'] = config.siteName;
  }

  return headers;
}

async function requestOpenRouterText(config: OpenRouterAgentConfig, systemPrompt: string, prompt: string): Promise<string> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= getRequestAttempts(config.model); attempt += 1) {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), config.timeoutMs ?? getDefaultTimeoutMs(config.model));

    try {
      const response = await fetch(config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature ?? 0.1,
          max_tokens: config.maxTokens ?? getDefaultMaxTokens(config.model),
          ...(usesJsonResponseFormat(config.model) ? { response_format: { type: 'json_object' } } : {}),
          reasoning: {
            effort: 'none',
            exclude: true,
          },
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

      const data = (await response.json()) as OpenRouterResponse;

      if (!response.ok) {
        throw new Error(data.error?.message ?? `OpenRouter request failed with status ${response.status}`);
      }

      const text = extractOpenRouterText(data);
      if (!text) {
        throw new Error('OpenRouter returned no text content for this turn.');
      }

      return text;
    } catch (error) {
      lastError = error;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenRouter request failed.');
}

function usesJsonResponseFormat(model: string): boolean {
  return model.trim() === KIMI_K26_MODEL;
}

function getDefaultMaxTokens(model: string): number {
  return model.trim() === KIMI_K26_MODEL ? KIMI_K26_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

function getDefaultTimeoutMs(model: string): number {
  return model.trim() === KIMI_K26_MODEL ? KIMI_K26_TIMEOUT_MS : 45_000;
}

function getRequestAttempts(model: string): number {
  return model.trim() === KIMI_K26_MODEL ? 3 : 1;
}

function extractOpenRouterText(data: OpenRouterResponse): string {
  const message = data.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => part.text ?? part.content ?? '')
      .join('')
      .trim();

    if (joined) {
      return joined;
    }
  }

  if (message?.reasoning) {
    const extracted = extractJSONObject(message.reasoning);
    if (extracted) {
      return extracted;
    }
  }

  return '';
}

function buildRepairPrompt(_basePrompt: string, legalActions: ArenaActionOption[], errorMessage: string): string {
  const legalActionSummary = legalActions.map((action) =>
    action.kind === 'pass' ? { kind: 'pass' } : { kind: 'play', actionId: action.actionId },
  );

  return [
    `Previous reply invalid: ${errorMessage}`,
    'Reply with exactly one JSON object and nothing else.',
    'Allowed outputs:',
    ...legalActionSummary.map((action) => JSON.stringify(action)),
  ].join('\n\n');
}

function buildCandidateRepairPrompt(candidates: RerankerCandidate[], errorMessage: string): string {
  return [
    `Previous reply invalid: ${errorMessage}`,
    'Reply with exactly one JSON object and nothing else.',
    'Allowed outputs:',
    ...candidates.map((candidate) => JSON.stringify(candidate.action)),
  ].join('\n\n');
}

function buildRerankerPrompt(input: ArenaTurnInput, candidates: RerankerCandidate[]): string {
  const fallbackCandidate = candidates.find((candidate) => candidate.isFallback) ?? candidates[0];

  return [
    'Task',
    'Choose exactly one action from the candidate shortlist below.',
    'You may only return one of the listed JSON actions.',
    'Prefer the fallback if no candidate clearly improves team outcome.',
    '',
    `Legacy fallback: ${formatCandidateHeader(fallbackCandidate)}`,
    '',
    'Candidate Shortlist',
    ...candidates.map(formatRerankerCandidate),
    '',
    'Full State Snapshot',
    formatTurnInputAsPrompt(input),
  ].join('\n');
}

function buildRerankerCandidates(
  state: Parameters<typeof rankLegacyV1ActionCandidates>[0],
  input: ArenaTurnInput,
  fallback: ArenaChosenAction,
  topK: number,
): RerankerCandidate[] {
  const ranked = rankLegacyV1ActionCandidates(state, input.seat);
  const fallbackKey = actionKey(fallback);
  const seen = new Set<string>();
  const candidates: RerankerCandidate[] = [];

  for (const [index, candidate] of ranked.entries()) {
    const resolved = resolveRerankerCandidate(candidate, input.legalActions, index + 1, fallbackKey);
    if (!resolved || seen.has(resolved.key)) {
      continue;
    }

    seen.add(resolved.key);
    candidates.push(resolved);

    if (candidates.length >= topK) {
      break;
    }
  }

  if (!seen.has(fallbackKey)) {
    const fallbackCandidate = resolveFallbackCandidate(fallback, input.legalActions, candidates.length + 1);
    if (fallbackCandidate) {
      candidates.push({
        ...fallbackCandidate,
        isFallback: true,
      });
    }
  }

  return candidates;
}

function resolveRerankerCandidate(
  candidate: ReturnType<typeof rankLegacyV1ActionCandidates>[number],
  legalActions: ArenaActionOption[],
  legacyRank: number,
  fallbackKey: string,
): RerankerCandidate | null {
  if (candidate.type === 'pass') {
    const passOption = legalActions.find((action) => action.kind === 'pass') ?? null;
    if (!passOption) {
      return null;
    }

    return {
      key: 'pass',
      action: { kind: 'pass' },
      option: passOption,
      legacyRank,
      legacyScore: candidate.score,
      isFallback: fallbackKey === 'pass',
    };
  }

  if (!candidate.play) {
    return null;
  }

  const actionId = actionIdForPlayKey(candidate.play.key);
  const option = legalActions.find((action) => action.kind === 'play' && action.actionId === actionId) ?? null;
  if (!option) {
    return null;
  }

  return {
    key: actionId,
    action: {
      kind: 'play',
      actionId,
    },
    option,
    legacyRank,
    legacyScore: candidate.score,
    isFallback: fallbackKey === actionId,
  };
}

function resolveFallbackCandidate(
  fallback: ArenaChosenAction,
  legalActions: ArenaActionOption[],
  legacyRank: number,
): RerankerCandidate | null {
  const key = actionKey(fallback);

  if (fallback.kind === 'pass') {
    const option = legalActions.find((action) => action.kind === 'pass') ?? null;
    if (!option) {
      return null;
    }

    return {
      key,
      action: fallback,
      option,
      legacyRank,
      legacyScore: Number.NEGATIVE_INFINITY,
      isFallback: true,
    };
  }

  const option = legalActions.find((action) => action.kind === 'play' && action.actionId === fallback.actionId) ?? null;
  if (!option) {
    return null;
  }

  return {
    key,
    action: fallback,
    option,
    legacyRank,
    legacyScore: Number.NEGATIVE_INFINITY,
    isFallback: true,
  };
}

function validateRerankerAction(action: ArenaChosenAction, candidates: RerankerCandidate[]): ArenaChosenAction {
  const chosenKey = actionKey(action);
  if (!candidates.some((candidate) => candidate.key === chosenKey)) {
    throw new Error(`Chosen action "${chosenKey}" is outside the reranker candidate shortlist.`);
  }

  return action;
}

function formatRerankerCandidate(candidate: RerankerCandidate): string {
  const option = candidate.option;
  const lines = [
    `- Candidate #${candidate.legacyRank}${candidate.isFallback ? ' [legacy-fallback]' : ''}`,
    `  legacyScore=${candidate.legacyScore}`,
    `  action=${JSON.stringify(candidate.action)}`,
  ];

  if (!option || option.kind === 'pass' || !option.play) {
    lines.push('  summary=pass');
    return lines.join('\n');
  }

  lines.push(
    `  summary=${option.label} | type=${option.play.type} | size=${option.play.size} | primary=${option.play.primaryValue} | bomb=${option.play.bombSize ?? '-'} | wild=${option.play.wildCount} | cards=${option.play.cards.map((card) => `${card.rank}-${card.suit}${card.isWild ? '*' : ''}`).join(' ')}`,
  );

  return lines.join('\n');
}

function formatCandidateHeader(candidate: RerankerCandidate): string {
  return `${JSON.stringify(candidate.action)} | legacyScore=${candidate.legacyScore}`;
}

function toArenaChosenAction(decision: ReturnType<typeof chooseAiAction>): ArenaChosenAction {
  if (decision.type === 'play' && decision.play) {
    return {
      kind: 'play',
      actionId: actionIdForPlayKey(decision.play.key),
    };
  }

  return { kind: 'pass' };
}

function actionIdForPlayKey(playKey: string): string {
  return `play:${playKey}`;
}

function actionKey(action: ArenaChosenAction): string {
  return action.kind === 'pass' ? 'pass' : action.actionId;
}

function emitStatus(
  config: OpenRouterAgentConfig,
  mode: OpenRouterAgentMode,
  event: Omit<OpenRouterStatusEvent, 'agentId' | 'agentLabel' | 'seat' | 'mode' | 'model' | 'timestamp'>,
): void {
  config.onStatus?.({
    ...event,
    agentId: config.id,
    agentLabel: config.label,
    seat: config.seat,
    mode,
    model: config.model.trim() || (mode === 'llmreranker' ? OPENROUTER_DEFAULT_RERANKER_MODEL : 'unset-model'),
    timestamp: Date.now(),
  });
}

function emitRerankDecision(
  config: OpenRouterAgentConfig,
  event: Omit<
    OpenRouterRerankDecisionEvent,
    'agentId' | 'agentLabel' | 'seat' | 'model' | 'timestamp' | 'deviatedFromLegacyTop' | 'deviatedFromLegacyFallback'
  >,
): void {
  const chosenKey = actionKey(event.chosenAction);
  const fallbackKey = actionKey(event.fallbackAction);

  config.onRerankDecision?.({
    ...event,
    agentId: config.id,
    agentLabel: config.label,
    seat: config.seat,
    model: config.model.trim() || OPENROUTER_DEFAULT_RERANKER_MODEL,
    timestamp: Date.now(),
    deviatedFromLegacyTop: event.chosenLegacyRank !== null && event.chosenLegacyRank > 1,
    deviatedFromLegacyFallback: chosenKey !== fallbackKey,
  });
}

function chooseFallbackAction(legalActions: ArenaActionOption[]): ArenaChosenAction {
  const firstPlay = legalActions.find((action) => action.kind === 'play');
  if (firstPlay) {
    return {
      kind: 'play',
      actionId: firstPlay.actionId,
    };
  }

  if (legalActions.some((action) => action.kind === 'pass')) {
    return { kind: 'pass' };
  }

  throw new Error('No legal actions available for fallback.');
}

function extractJSONObject(raw: string): string {
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return '';
  }

  return raw.slice(firstBrace, lastBrace + 1).trim();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'invalid response';
}

function formatChosenAction(action: ArenaChosenAction): string {
  return JSON.stringify(action);
}

function formatInvalidReplyDetail(error: unknown, raw: string): string {
  return joinStatusDetails(
    `Parser error: ${getErrorMessage(error)}`,
    `Raw reply:\n${truncateForStatus(raw)}`,
  );
}

function joinStatusDetails(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join('\n\n');
}

function truncateForStatus(raw: string, maxLength: number = 420): string {
  if (raw.length <= maxLength) {
    return raw;
  }

  return `${raw.slice(0, maxLength)}…`;
}

import type { Seat } from '../game/types';
import { parseArenaChosenAction } from './engine';
import { formatArenaLlmSystemPrompt, formatTurnInputAsPrompt } from './prompt';
import type { ArenaActionOption, ArenaChosenAction, GuandanArenaAgent } from './types';

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
}

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
  model: string;
  level: OpenRouterStatusLevel;
  code: OpenRouterStatusCode;
  message: string;
  detail?: string;
  timestamp: number;
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
const DEFAULT_MAX_TOKENS = 96;
const KIMI_K26_MODEL = 'moonshotai/kimi-k2.6';
const KIMI_K26_MAX_TOKENS = 512;
const KIMI_K26_TIMEOUT_MS = 90_000;

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
        requestConfig: config,
        systemPrompt,
        prompt: basePrompt,
        requestMessage: 'Calling model for action selection.',
        buildRepairPrompt: (errorMessage) => buildRepairPrompt(legalActions, errorMessage),
        parseAction: (raw) => parseArenaChosenAction(raw, legalActions),
        fallbackAction: fallback,
        fallbackReasonLabel: 'Repair failed, using builtin legal fallback.',
      });
    },
  };
}

interface OpenRouterDecisionFlowConfig {
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
  emitStatus(config.requestConfig, {
    code: 'requesting',
    level: 'info',
    message: config.requestMessage,
  });

  try {
    const firstRaw = await requestOpenRouterText(config.requestConfig, config.systemPrompt, config.prompt);

    try {
      const action = config.parseAction(firstRaw);
      emitStatus(config.requestConfig, {
        code: 'success',
        level: 'success',
        message: `Model reply accepted: ${formatChosenAction(action)}.`,
      });
      return action;
    } catch (firstParseError) {
      const firstErrorMessage = getErrorMessage(firstParseError);
      const invalidDetail = formatInvalidReplyDetail(firstParseError, firstRaw);

      emitStatus(config.requestConfig, {
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

    emitStatus(config.requestConfig, {
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
  emitStatus(config.requestConfig, {
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
      emitStatus(config.requestConfig, {
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

      emitStatus(config.requestConfig, {
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

    emitStatus(config.requestConfig, {
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

function buildRepairPrompt(legalActions: ArenaActionOption[], errorMessage: string): string {
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

function emitStatus(
  config: OpenRouterAgentConfig,
  event: Omit<OpenRouterStatusEvent, 'agentId' | 'agentLabel' | 'seat' | 'model' | 'timestamp'>,
): void {
  config.onStatus?.({
    ...event,
    agentId: config.id,
    agentLabel: config.label,
    seat: config.seat,
    model: config.model.trim() || 'unset-model',
    timestamp: Date.now(),
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

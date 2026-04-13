import { parseArenaChosenAction } from './engine';
import { formatTurnInputAsPrompt } from './prompt';
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

export function createOpenRouterAgent(config: OpenRouterAgentConfig): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    async decideTurn(input) {
      const basePrompt = formatTurnInputAsPrompt(input);
      const legalActions = input.legalActions;

      try {
        const firstRaw = await requestOpenRouterText(config, basePrompt);
        return parseArenaChosenAction(firstRaw, legalActions);
      } catch (firstError) {
        try {
          const secondRaw = await requestOpenRouterText(
            config,
            buildRepairPrompt(basePrompt, legalActions, getErrorMessage(firstError)),
          );
          return parseArenaChosenAction(secondRaw, legalActions);
        } catch {
          return chooseFallbackAction(legalActions);
        }
      }
    },
  };
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

async function requestOpenRouterText(config: OpenRouterAgentConfig, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), config.timeoutMs ?? 45_000);

  try {
    const response = await fetch(config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature ?? 0.1,
        max_tokens: config.maxTokens ?? 600,
        messages: [
          {
            role: 'system',
            content:
              'You are playing Guandan in a code-driven arena. Always choose exactly one legal action and return JSON only.',
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
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
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

function buildRepairPrompt(basePrompt: string, legalActions: ArenaActionOption[], errorMessage: string): string {
  const legalActionSummary = legalActions.map((action) => ({
    kind: action.kind,
    actionId: action.actionId,
    label: action.label,
  }));

  return [
    basePrompt,
    `Your previous answer was invalid for this turn: ${errorMessage}`,
    'Reply again with exactly one valid JSON action. Do not explain.',
    JSON.stringify({ legalActions: legalActionSummary }, null, 2),
  ].join('\n\n');
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

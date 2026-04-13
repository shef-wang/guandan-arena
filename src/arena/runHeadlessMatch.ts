declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { createHeuristicAgent, createFunctionAgent, GuandanArenaMatch, parseArenaChosenAction } from './engine';
import { formatTurnInputAsPrompt } from './prompt';
import type { ArenaChosenAction, GuandanArenaAgent } from './types';

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
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface UsageAccumulator {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4.1-nano';

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const baseUrl = process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const usageBySeat: Record<0 | 2, UsageAccumulator> = {
    0: createUsageAccumulator(),
    2: createUsageAccumulator(),
  };

  const match = new GuandanArenaMatch({
    agents: [
      createTrackedOpenRouterAgent({
        apiKey,
        baseUrl,
        label: 'Seat 0 LLM',
        model,
        seat: 0,
        usage: usageBySeat[0],
      }),
      createHeuristicAgent({
        id: 'builtin-balanced-seat-1',
        label: 'Seat 1 Balanced',
        profile: 'balanced-v2',
      }),
      createTrackedOpenRouterAgent({
        apiKey,
        baseUrl,
        label: 'Seat 2 LLM',
        model,
        seat: 2,
        usage: usageBySeat[2],
      }),
      createHeuristicAgent({
        id: 'builtin-balanced-seat-3',
        label: 'Seat 3 Balanced',
        profile: 'balanced-v2',
      }),
    ],
  });

  const resultState = await match.runUntilFinished({ maxTurns: 500 });
  const totalUsage = mergeUsage(usageBySeat[0], usageBySeat[2]);
  const includeTrace = process.env.OUTPUT_TRACE === '1';

  console.log(
    JSON.stringify(
      {
        model,
        turns: resultState.actionHistory.length,
        finishOrder: resultState.finishOrder.map((seat) => ({
          seat,
          name: resultState.players[seat].name,
          team: resultState.players[seat].team,
        })),
        result: resultState.result,
        llmTeam: {
          seats: [0, 2],
          won: resultState.result?.winnerTeam === 0,
        },
        usage: {
          seat0: usageBySeat[0],
          seat2: usageBySeat[2],
          total: totalUsage,
        },
        actionHistory: includeTrace
          ? resultState.actionHistory.map((entry) => ({
              turn: entry.turn,
              seat: entry.seat,
              actor: resultState.players[entry.seat].name,
              team: resultState.players[entry.seat].team,
              action: entry.action,
              play: entry.play
                ? {
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

function createTrackedOpenRouterAgent(config: {
  seat: 0 | 2;
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  usage: UsageAccumulator;
}): GuandanArenaAgent {
  return createFunctionAgent({
    id: `openrouter-seat-${config.seat}`,
    label: config.label,
    async decideTurn(input) {
      const prompt = formatTurnInputAsPrompt(input);
      return await requestValidAction(config, prompt, input.legalActions);
    },
  });
}

async function requestValidAction(
  config: {
    label: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    usage: UsageAccumulator;
  },
  prompt: string,
  legalActions: Parameters<typeof parseArenaChosenAction>[1],
): Promise<ArenaChosenAction> {
  const firstAttempt = await requestOpenRouterCompletion(config, prompt);

  try {
    return parseArenaChosenAction(firstAttempt.raw, legalActions);
  } catch (error) {
    const repairMessage = error instanceof Error ? error.message : 'Invalid action';
    const repairPrompt = `${prompt}\n\nYour previous reply was invalid: ${repairMessage}\nReturn one valid JSON action only.`;
    const secondAttempt = await requestOpenRouterCompletion(config, repairPrompt);
    return parseArenaChosenAction(secondAttempt.raw, legalActions);
  }
}

async function requestOpenRouterCompletion(
  config: {
    label: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    usage: UsageAccumulator;
  },
  prompt: string,
): Promise<{ raw: string }> {
  const response = await fetch(config.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 96,
      messages: [
        {
          role: 'system',
          content:
            'You are playing Guandan in a code-driven arena. Return JSON only. Choose exactly one action from legalActions. Do not explain.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const data = (await response.json()) as OpenRouterResponse;
  if (!response.ok) {
    throw new Error(data.error?.message ?? `OpenRouter request failed with status ${response.status}`);
  }

  const raw = extractText(data);
  if (!raw) {
    throw new Error('OpenRouter returned empty content.');
  }

  accumulateUsage(config.usage, data, prompt, raw);
  return { raw };
}

function extractText(data: OpenRouterResponse): string {
  const content = data.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text ?? '')
      .join('')
      .trim();
  }

  return '';
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(message);
  process.exitCode = 1;
});

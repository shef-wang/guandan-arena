import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { applyAgentAction, advanceAgentBatch, createAgentBatchState, type AgentBatchState } from '../src/agentMode/core';
import { buildAgentJsonResponse, renderAgentHtml } from '../src/agentMode/render';
import type { ArenaChosenAction } from '../src/arena/types';

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const stateToken = url.searchParams.get('state');
    const batch = stateToken ? decodeBatchState(stateToken) : createAgentBatchState(readConfigFromUrl(url));
    const decision = advanceAgentBatch(batch);
    return respond(request, decision, null);
  } catch (error) {
    return respondWithFatalError(request, getErrorMessage(error), 400);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await readPostPayload(request);
    if (!payload.state) {
      throw new Error('Missing serialized batch state.');
    }

    const batch = decodeBatchState(payload.state);

    try {
      const action = parseSubmittedAction(payload.action);
      const decision = applyAgentAction(batch, action);
      return respond(request, decision, null);
    } catch (actionError) {
      const decision = advanceAgentBatch(batch);
      return respond(request, decision, getErrorMessage(actionError), 400);
    }
  } catch (error) {
    return respondWithFatalError(request, getErrorMessage(error), 400);
  }
}

async function readPostPayload(request: Request): Promise<{ state: string; action: string }> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await request.json()) as { state?: string; action?: string };
    return {
      state: String(body.state ?? ''),
      action: String(body.action ?? ''),
    };
  }

  const form = await request.formData();
  return {
    state: String(form.get('state') ?? ''),
    action: String(form.get('action') ?? ''),
  };
}

function readConfigFromUrl(url: URL): {
  totalMatches?: number;
  baseSeed?: number;
  playerSeat?: number;
} {
  return {
    totalMatches: parseOptionalInteger(url.searchParams.get('matches')),
    baseSeed: parseOptionalInteger(url.searchParams.get('seed')),
    playerSeat: parseOptionalInteger(url.searchParams.get('seat')),
  };
}

function parseOptionalInteger(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSubmittedAction(raw: string): ArenaChosenAction {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new Error('Missing action.');
  }

  if (trimmed === 'pass') {
    return { kind: 'pass' };
  }

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as ArenaChosenAction;
  }

  return {
    kind: 'play',
    actionId: trimmed,
  };
}

function encodeBatchState(batch: AgentBatchState): string {
  const json = JSON.stringify(batch);
  return deflateRawSync(Buffer.from(json, 'utf8')).toString('base64url');
}

function decodeBatchState(token: string): AgentBatchState {
  const inflated = inflateRawSync(Buffer.from(token, 'base64url')).toString('utf8');
  return JSON.parse(inflated) as AgentBatchState;
}

function wantsJson(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get('format') === 'json') {
    return true;
  }

  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json');
}

function respond(
  request: Request,
  decision: ReturnType<typeof advanceAgentBatch>,
  actionError: string | null,
  status = 200,
): Response {
  const token = encodeBatchState(decision.batch);
  const requestUrl = request.url;

  if (wantsJson(request)) {
    return new Response(
      JSON.stringify(
        buildAgentJsonResponse({
          decision,
          token,
          actionError,
          requestUrl,
        }),
        null,
        2,
      ),
      {
        status,
        headers: buildHeaders('application/json; charset=utf-8'),
      },
    );
  }

  return new Response(
    renderAgentHtml({
      decision,
      token,
      actionError,
      requestUrl,
    }),
    {
      status,
      headers: buildHeaders('text/html; charset=utf-8'),
    },
  );
}

function respondWithFatalError(request: Request, message: string, status: number): Response {
  if (wantsJson(request)) {
    return new Response(
      JSON.stringify(
        {
          version: 1,
          mode: 'guandan-agent',
          status: 'error',
          error: message,
        },
        null,
        2,
      ),
      {
        status,
        headers: buildHeaders('application/json; charset=utf-8'),
      },
    );
  }

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Guandan Agent Mode Error</title></head><body style="font-family: monospace; background:#08121a; color:#e8eef7; padding:24px;"><h1>Guandan Agent Mode</h1><p>Fatal request error.</p><pre>${escapeHtml(
      message,
    )}</pre><p><a href="/agent?matches=10" style="color:#8dd3ff;">Start a new batch</a></p></body></html>`,
    {
      status,
      headers: buildHeaders('text/html; charset=utf-8'),
    },
  );
}

function buildHeaders(contentType: string): Headers {
  return new Headers({
    'content-type': contentType,
    'cache-control': 'no-store, max-age=0',
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

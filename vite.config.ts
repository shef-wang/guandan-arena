import react from '@vitejs/plugin-react';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { defineConfig, type ViteDevServer } from 'vite';

interface PendingPolicyRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class ScoreNetDevPolicyServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private checkpoint: string | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingPolicyRequest>();

  async choose(checkpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensure(checkpoint);
    if (!this.child) {
      throw new Error('ScoreNet policy server is not running.');
    }

    const id = this.nextId++;
    return await new Promise<Record<string, unknown>>((resolveChoice, rejectChoice) => {
      this.pending.set(id, { resolve: resolveChoice, reject: rejectChoice });
      this.child!.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  private async ensure(checkpoint: string): Promise<void> {
    if (this.child && this.checkpoint === checkpoint && this.ready) {
      await this.ready;
      return;
    }

    this.close();
    this.checkpoint = checkpoint;
    const pythonBin = process.env.PYTHON_BIN ?? '.venv-danzero/bin/python';
    const args = [
      'training/scorenet/serve_policy.py',
      '--checkpoint',
      checkpoint,
      '--device',
      process.env.SCORENET_DEVICE ?? 'mps',
      '--cpu-fraction',
      process.env.CPU_FRACTION ?? '1.0',
      '--mps-memory-fraction',
      process.env.MPS_MEMORY_FRACTION ?? '0.95',
    ];

    this.child = spawn(pythonBin, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = createInterface({ input: this.child.stdout });
    const stderr = createInterface({ input: this.child.stderr });
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      stdout.once('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { ready?: boolean; error?: string };
          if (parsed.ready) {
            resolveReady();
            return;
          }
          rejectReady(new Error(parsed.error ?? `Unexpected ScoreNet hello: ${line}`));
        } catch (error) {
          rejectReady(error instanceof Error ? error : new Error('Unable to parse ScoreNet hello.'));
        }
      });
    });

    stdout.on('line', (line) => {
      if (line.includes('"ready"')) return;
      const parsed = JSON.parse(line) as { id: number; error?: string } & Record<string, unknown>;
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error));
        return;
      }
      pending.resolve(parsed);
    });

    stderr.on('line', (line) => {
      console.warn(`[scorenet-policy] ${line}`);
    });

    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`ScoreNet policy server exited with code ${code ?? -1}`));
      }
      this.pending.clear();
      this.child = null;
      this.ready = null;
    });

    await this.ready;
  }

  close(): void {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = null;
    this.ready = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('ScoreNet policy server restarted.'));
    }
    this.pending.clear();
  }
}

const policyServer = new ScoreNetDevPolicyServer();
const OPENROUTER_LOCAL_KEY_CANDIDATES = ['apikey/key.rtf', 'key.rtf', 'apikey/key', 'key'] as const;

/** Default weights bundled in git (ppo_iter 80 · epoch 10). */
const SCORENET_CHECKPOINT_ROOT = () => resolve(process.cwd(), 'training/scorenet/checkpoints');
const DEFAULT_SCORENET_CHECKPOINT_RELATIVE =
  'training/scorenet/checkpoints/stability_v3_20260503_180902/ppo_iter_080/ppo/epoch_010.pt';

export default defineConfig({
  plugins: [react(), scoreNetDevApi()],
});

function scoreNetDevApi() {
  return {
    name: 'scorenet-dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0];
        if (pathname !== '/api/scorenet/status' && pathname !== '/api/scorenet/choose' && pathname !== '/api/openrouter/local-key') {
          next();
          return;
        }

        try {
          if (pathname === '/api/openrouter/local-key' && req.method === 'GET') {
            const localKey = resolveLocalOpenRouterKey();
            sendJson(res, {
              available: Boolean(localKey),
              key: localKey?.key ?? null,
              source: localKey?.source ?? null,
            });
            return;
          }

          if (pathname === '/api/scorenet/status' && req.method === 'GET') {
            const checkpoint = findLatestScoreNetCheckpoint();
            sendJson(res, {
              available: Boolean(checkpoint),
              checkpoint: checkpoint ? relative(process.cwd(), checkpoint) : null,
            });
            return;
          }

          if (pathname === '/api/scorenet/choose' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const checkpoint = resolveRequestedCheckpoint(body.checkpoint);
            if (!checkpoint) {
              sendJson(res, { error: 'No ScoreNet PPO checkpoint found.' }, 404);
              return;
            }

            const choice = await policyServer.choose(checkpoint, {
              state_features: body.stateFeatures,
              action_features: body.actionFeatures,
              sample: false,
            });
            sendJson(res, { ...choice, checkpoint: relative(process.cwd(), checkpoint) });
            return;
          }

          sendJson(res, { error: 'Unsupported method.' }, 405);
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : 'Unknown ScoreNet API error.' }, 500);
        }
      });
    },
  };
}

function resolveRequestedCheckpoint(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const candidate = resolve(process.cwd(), raw.trim());
    const checkpointRoot = SCORENET_CHECKPOINT_ROOT();
    if (!candidate.startsWith(`${checkpointRoot}/`) || !existsSync(candidate)) {
      throw new Error('Invalid ScoreNet checkpoint path.');
    }
    return candidate;
  }

  return findLatestScoreNetCheckpoint();
}

/** Resolve repo-relative `.pt` under `training/scorenet/checkpoints/`, or return null + warn if invalid. */
function resolveOptionalCheckpointFromEnv(trimmedRelative: string): string | null {
  const candidate = resolve(process.cwd(), trimmedRelative);
  const checkpointRoot = SCORENET_CHECKPOINT_ROOT();
  if (!candidate.startsWith(`${checkpointRoot}/`) || !existsSync(candidate)) {
    console.warn(
      `[scorenet-dev-api] SCORENET_CHECKPOINT ignored (missing file or outside training/scorenet/checkpoints): ${trimmedRelative}`,
    );
    return null;
  }
  return candidate;
}

function findLatestScoreNetCheckpoint(): string | null {
  const checkpointRoot = SCORENET_CHECKPOINT_ROOT();

  const envOverride = process.env.SCORENET_CHECKPOINT?.trim();
  if (envOverride) {
    const resolved = resolveOptionalCheckpointFromEnv(envOverride);
    if (resolved) {
      return resolved;
    }
  }

  const usePinnedDefault = process.env.SCORENET_USE_PINNED !== '0';
  const pinnedAbsolute = resolve(process.cwd(), DEFAULT_SCORENET_CHECKPOINT_RELATIVE);
  if (usePinnedDefault && existsSync(pinnedAbsolute)) {
    return pinnedAbsolute;
  }

  if (!existsSync(checkpointRoot)) return null;

  let latest: { path: string; mtimeMs: number; iteration: number; epoch: number; isSmoke: boolean } | null = null;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (!/^epoch_\d+\.pt$/.test(entry.name) || basename(dirname(fullPath)) !== 'ppo') {
        continue;
      }

      const relativePath = relative(checkpointRoot, fullPath);
      const iteration = Number(relativePath.match(/ppo_iter_(\d+)/)?.[1] ?? 0);
      const epoch = Number(entry.name.match(/epoch_(\d+)\.pt/)?.[1] ?? 0);
      const isSmoke = relativePath.toLowerCase().includes('smoke');
      const stats = statSync(fullPath);
      const candidate = { path: fullPath, mtimeMs: stats.mtimeMs, iteration, epoch, isSmoke };

      if (!latest || compareCheckpoints(candidate, latest) > 0) {
        latest = candidate;
      }
    }
  };

  visit(checkpointRoot);
  return latest?.path ?? null;
}

/** Higher return value ⇒ `a` is a better checkpoint than `b`. */
function compareCheckpoints(
  a: { mtimeMs: number; iteration: number; epoch: number; isSmoke: boolean },
  b: { mtimeMs: number; iteration: number; epoch: number; isSmoke: boolean },
): number {
  if (a.isSmoke !== b.isSmoke) return a.isSmoke ? -1 : 1;
  // Prefer strongest training milestone (ppo_iter × epoch); mtime breaks ties only — file mtime alone
  // wrongly picked unrelated recently-touched shallow runs ahead of bundled stability_v3 weights.
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  return a.mtimeMs - b.mtimeMs;
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: import('node:http').ServerResponse, body: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function resolveLocalOpenRouterKey(): { key: string; source: string } | null {
  for (const relativePath of OPENROUTER_LOCAL_KEY_CANDIDATES) {
    const absolutePath = resolve(process.cwd(), relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const key = readOpenRouterKeyFile(absolutePath).replace(/\s+/g, '');
    if (key) {
      return {
        key,
        source: relative(process.cwd(), absolutePath),
      };
    }
  }

  return null;
}

function readOpenRouterKeyFile(absolutePath: string): string {
  if (absolutePath.endsWith('.rtf')) {
    try {
      return execFileSync('textutil', ['-convert', 'txt', '-stdout', absolutePath], { encoding: 'utf8' });
    } catch {
      // Fall back to raw file read if textutil fails.
    }
  }

  return readFileSync(absolutePath, 'utf8');
}

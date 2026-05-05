/**
 * Wall-clock ms per decideTurn() for ScoreNet (Python server + feature encode)
 * vs legacy-v3.0 heuristic, measured over several full arena matches.
 *
 *   CHECKPOINT=... MATCHES=15 SCORENET_DEVICE=mps npx esbuild training/scorenet/bench_move_latency.ts --bundle --platform=node --format=cjs --outfile=/tmp/bench_move_latency.cjs && node /tmp/bench_move_latency.cjs
 */
declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createFunctionAgent, createHeuristicAgent, GuandanArenaMatch } from '../../src/arena/engine';
import type { AiProfile } from '../../src/game/ai';
import { createSeededRandom } from '../../src/game/cards';
import { createNewGame } from '../../src/game/state';
import type { ArenaChosenAction, GuandanArenaAgent } from '../../src/arena/types';
import { buildHeuristicContext, encodeTurnForPolicy } from './feature_codec';

interface PendingRequest {
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

class PythonPolicyClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readonly ready: Promise<void>;

  constructor(
    pythonBin: string,
    checkpoint: string,
    cpuFraction: number,
    mpsMemoryFraction: number,
    device: string | null,
  ) {
    const args = [
      'training/scorenet/serve_policy.py',
      '--checkpoint',
      checkpoint,
      '--cpu-fraction',
      String(cpuFraction),
      '--mps-memory-fraction',
      String(mpsMemoryFraction),
    ];
    if (device) {
      args.push('--device', device);
    }
    this.child = spawn(pythonBin, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = createInterface({ input: this.child.stdout });
    const stderr = createInterface({ input: this.child.stderr });
    this.ready = new Promise<void>((resolve, reject) => {
      stdout.once('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { ready?: boolean; error?: string };
          if (parsed.ready) {
            resolve();
            return;
          }
          reject(new Error(parsed.error ?? `Unexpected server hello: ${line}`));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Unable to parse policy server hello.'));
        }
      });
    });

    stdout.on('line', (line) => {
      if (line.includes('"ready"')) return;
      const parsed = JSON.parse(line) as { id: number; chosen_index?: number; error?: string };
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error));
        return;
      }
      pending.resolve(parsed.chosen_index ?? 0);
    });

    stderr.on('line', (line) => {
      console.error(`[policy-server] ${line}`);
    });

    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Policy server exited with code ${code ?? -1}`));
      }
      this.pending.clear();
    });
  }

  async chooseActionIndex(
    input: Parameters<GuandanArenaAgent['decideTurn']>[0],
    state: Parameters<GuandanArenaAgent['decideTurn']>[1]['state'],
    seat: 0 | 1 | 2 | 3,
  ): Promise<number> {
    await this.ready;
    const requestId = this.nextId++;
    const heuristic = buildHeuristicContext(state, seat);
    const encoded = encodeTurnForPolicy(input, heuristic);

    return await new Promise<number>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({
          id: requestId,
          state_features: encoded.stateFeatures,
          action_features: encoded.actionFeatures,
          sample: false,
        }) + '\n',
      );
    });
  }

  async close(): Promise<void> {
    if (this.child.killed) return;
    this.child.stdin.end();
    this.child.kill();
  }
}

function wrapTiming(agent: GuandanArenaAgent, msTotal: { value: number }, moves: { value: number }): GuandanArenaAgent {
  return {
    ...agent,
    async decideTurn(input, context) {
      const t0 = performance.now();
      const out = await agent.decideTurn(input, context);
      msTotal.value += performance.now() - t0;
      moves.value += 1;
      return out;
    },
  };
}

function buildLearnedAgent(client: PythonPolicyClient): GuandanArenaAgent {
  return createFunctionAgent({
    id: 'scorenet-policy',
    label: 'ScoreNet',
    async decideTurn(input, context): Promise<ArenaChosenAction> {
      const chosenIndex = await client.chooseActionIndex(input, context.state, context.seat);
      const chosen =
        input.legalActions[Math.max(0, Math.min(chosenIndex, input.legalActions.length - 1))] ?? input.legalActions[0];
      if (!chosen) {
        throw new Error('No legal actions available for learned agent.');
      }
      if (chosen.kind === 'pass') {
        return { kind: 'pass' };
      }
      return { kind: 'play', actionId: chosen.actionId };
    },
  });
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '20');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260416');
  const checkpoint = process.env.CHECKPOINT;
  const pythonBin = process.env.PYTHON_BIN ?? '.venv-danzero/bin/python';
  const opponentProfile = (process.env.OPPONENT_PROFILE ?? 'legacy-v3.0') as AiProfile;
  const cpuFraction = Number(process.env.CPU_FRACTION ?? '1.0');
  const mpsMemoryFraction = Number(process.env.MPS_MEMORY_FRACTION ?? '0.95');
  const scoreNetDevice = process.env.SCORENET_DEVICE ?? null;
  const duplicateDeals = (process.env.EVAL_DUPLICATE_DEALS ?? '1') !== '0';

  if (!checkpoint) {
    throw new Error('CHECKPOINT is required.');
  }

  const client = new PythonPolicyClient(pythonBin, checkpoint, cpuFraction, mpsMemoryFraction, scoreNetDevice);
  const learnedMs = { value: 0 };
  const learnedMoves = { value: 0 };
  const legacyMs = { value: 0 };
  const legacyMoves = { value: 0 };

  try {
    for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
      const pairIndex = duplicateDeals ? Math.floor(matchIndex / 2) : matchIndex;
      const phase = duplicateDeals ? matchIndex % 2 : 0;
      const learnedTeam = (
        duplicateDeals ? (phase === 0 ? 0 : 1) : matchIndex % 2 === 0 ? 0 : 1
      ) as 0 | 1;
      const random = createSeededRandom(baseSeed + pairIndex);
      const learnedBase = buildLearnedAgent(client);
      const legacySeat0 = createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 0' });
      const legacySeat1 = createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 1' });
      const learnedWrapped = wrapTiming(learnedBase, learnedMs, learnedMoves);
      const legacyWrapped0 = wrapTiming(legacySeat0, legacyMs, legacyMoves);
      const legacyWrapped1 = wrapTiming(legacySeat1, legacyMs, legacyMoves);

      const match = new GuandanArenaMatch({
        initialState: createNewGame(random),
        agents:
          learnedTeam === 0
            ? [learnedWrapped, legacyWrapped0, learnedWrapped, legacyWrapped1]
            : [legacyWrapped0, learnedWrapped, legacyWrapped1, learnedWrapped],
      });

      const finalState = await match.runUntilFinished({ maxTurns: 500 });
      if (!finalState.result) {
        throw new Error(`Match ${matchIndex + 1} ended without a result.`);
      }
    }
  } finally {
    await client.close();
  }

  const learnedPerMove = learnedMoves.value > 0 ? learnedMs.value / learnedMoves.value : 0;
  const legacyPerMove = legacyMoves.value > 0 ? legacyMs.value / legacyMoves.value : 0;
  console.log(
    JSON.stringify(
      {
        checkpoint,
        opponentProfile,
        matches,
        duplicateDeals,
        scoreNetDevice,
        learned: {
          decisions: learnedMoves.value,
          totalMs: learnedMs.value,
          msPerDecision: learnedPerMove,
          secondsPerDecision: learnedPerMove / 1000,
        },
        legacy: {
          decisions: legacyMoves.value,
          totalMs: legacyMs.value,
          msPerDecision: legacyPerMove,
          secondsPerDecision: legacyPerMove / 1000,
        },
        ratioLearnedOverLegacy: legacyPerMove > 0 ? learnedPerMove / legacyPerMove : null,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

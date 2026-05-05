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

  async chooseActionIndex(input: Parameters<GuandanArenaAgent['decideTurn']>[0], state: Parameters<GuandanArenaAgent['decideTurn']>[1]['state'], seat: 0 | 1 | 2 | 3): Promise<number> {
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

/** Signed level swing for the learned team (+levelDelta if learned wins, −if opponent wins). */
function signedLevelForLearned(finalState: { result: { winnerTeam: 0 | 1; levelDelta: number } }, learnedTeam: 0 | 1): number {
  const { winnerTeam, levelDelta } = finalState.result;
  return winnerTeam === learnedTeam ? levelDelta : -levelDelta;
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '100');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260416');
  const checkpoint = process.env.CHECKPOINT;
  const pythonBin = process.env.PYTHON_BIN ?? '.venv-danzero/bin/python';
  const opponentProfile = (process.env.OPPONENT_PROFILE ?? 'legacy-v3.0') as AiProfile;
  const cpuFraction = Number(process.env.CPU_FRACTION ?? '1.0');
  const mpsMemoryFraction = Number(process.env.MPS_MEMORY_FRACTION ?? '0.95');
  const scoreNetDevice = process.env.SCORENET_DEVICE ?? null;
  const duplicateDeals = (process.env.EVAL_DUPLICATE_DEALS ?? '1') !== '0';
  const evalMetric = (process.env.EVAL_METRIC ?? 'per_game').toLowerCase();
  const pairLevelMode = evalMetric === 'pair_level';

  if (!checkpoint) {
    throw new Error('CHECKPOINT is required.');
  }

  if (pairLevelMode && !duplicateDeals) {
    throw new Error('EVAL_METRIC=pair_level requires mirrored deals (EVAL_DUPLICATE_DEALS=1).');
  }
  if (pairLevelMode && matches % 2 !== 0) {
    throw new Error(`EVAL_METRIC=pair_level requires an even MATCHES count (got ${matches}).`);
  }

  const client = new PythonPolicyClient(pythonBin, checkpoint, cpuFraction, mpsMemoryFraction, scoreNetDevice);
  let learnedWins = 0;
  let legacyWins = 0;
  let learnedLevelGain = 0;
  let legacyLevelGain = 0;
  let signedNetLevelFromLearned = 0;
  let pairWins = 0;
  let pairNetLevelSum = 0;
  const pairCount = pairLevelMode ? matches / 2 : 0;

  try {
    if (!pairLevelMode) {
      for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
        const pairIndex = duplicateDeals ? Math.floor(matchIndex / 2) : matchIndex;
        const phase = duplicateDeals ? matchIndex % 2 : 0;
        const learnedTeam = (
          duplicateDeals ? (phase === 0 ? 0 : 1) : matchIndex % 2 === 0 ? 0 : 1
        ) as 0 | 1;
        const random = createSeededRandom(baseSeed + pairIndex);
        const learnedAgent = buildLearnedAgent(client);
        const match = new GuandanArenaMatch({
          initialState: createNewGame(random),
          agents:
            learnedTeam === 0
              ? [
                  learnedAgent,
                  createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 1' }),
                  learnedAgent,
                  createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 3' }),
                ]
              : [
                  createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 0' }),
                  learnedAgent,
                  createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 2' }),
                  learnedAgent,
                ],
        });

        const finalState = await match.runUntilFinished({ maxTurns: 500 });
        if (!finalState.result) {
          throw new Error(`Match ${matchIndex + 1} ended without a result.`);
        }

        signedNetLevelFromLearned += signedLevelForLearned(finalState, learnedTeam);

        if (finalState.result.winnerTeam === learnedTeam) {
          learnedWins += 1;
          learnedLevelGain += finalState.result.levelDelta;
        } else {
          legacyWins += 1;
          legacyLevelGain += finalState.result.levelDelta;
        }
      }
    } else {
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        let pairSigned = 0;
        for (let phase = 0; phase < 2; phase += 1) {
          const learnedTeam = (phase === 0 ? 0 : 1) as 0 | 1;
          const random = createSeededRandom(baseSeed + pairIndex);
          const learnedAgent = buildLearnedAgent(client);
          const match = new GuandanArenaMatch({
            initialState: createNewGame(random),
            agents:
              learnedTeam === 0
                ? [
                    learnedAgent,
                    createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 1' }),
                    learnedAgent,
                    createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 3' }),
                  ]
                : [
                    createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 0' }),
                    learnedAgent,
                    createHeuristicAgent({ profile: opponentProfile, label: 'Opponent 2' }),
                    learnedAgent,
                  ],
          });

          const finalState = await match.runUntilFinished({ maxTurns: 500 });
          if (!finalState.result) {
            throw new Error(`Pair ${pairIndex + 1} phase ${phase} ended without a result.`);
          }

          const s = signedLevelForLearned(finalState, learnedTeam);
          pairSigned += s;
          signedNetLevelFromLearned += s;

          if (finalState.result.winnerTeam === learnedTeam) {
            learnedWins += 1;
            learnedLevelGain += finalState.result.levelDelta;
          } else {
            legacyWins += 1;
            legacyLevelGain += finalState.result.levelDelta;
          }
        }
        pairNetLevelSum += pairSigned;
        if (pairSigned > 0) {
          pairWins += 1;
        }
      }
    }
  } finally {
    await client.close();
  }

  const pairMirror =
    pairLevelMode && pairCount > 0
      ? {
          pairs: pairCount,
          pairWins,
          pairWinRate: pairWins / pairCount,
          netLevelDeltaTotalAcrossPairs: pairNetLevelSum,
          netLevelDeltaPerPair: pairNetLevelSum / pairCount,
        }
      : undefined;

  const summary: Record<string, unknown> = {
    matches,
    baseSeed,
    checkpoint,
    opponentProfile,
    duplicateDeals,
    evalMetric: pairLevelMode ? 'pair_level' : 'per_game',
    learnedLevelGainTotal: learnedLevelGain,
    legacyLevelGainTotal: legacyLevelGain,
    netLevelDeltaFromLearnedPerspective: learnedLevelGain - legacyLevelGain,
    netLevelDeltaPerMatch: matches > 0 ? (learnedLevelGain - legacyLevelGain) / matches : 0,
    signedNetLevelFromLearned,
    signedNetLevelPerGame: matches > 0 ? signedNetLevelFromLearned / matches : 0,
    learned: {
      wins: learnedWins,
      winRate: learnedWins / matches,
      averageLevelGainOnWins: learnedWins > 0 ? learnedLevelGain / learnedWins : 0,
    },
    legacy: {
      wins: legacyWins,
      winRate: legacyWins / matches,
      averageLevelGainOnWins: legacyWins > 0 ? legacyLevelGain / legacyWins : 0,
    },
  };

  if (pairMirror) {
    summary.pairMirror = pairMirror;
  }

  console.log(JSON.stringify(summary, null, 2));
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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createFunctionAgent, createHeuristicAgent, GuandanArenaMatch } from '../../src/arena/engine';
import { createSeededRandom } from '../../src/game/cards';
import { createNewGame } from '../../src/game/state';
import type { ArenaChosenAction, ArenaTurnInput, GuandanArenaAgent } from '../../src/arena/types';
import { encodeTurnForPolicy } from './feature_codec';

interface EvalSummary {
  matches: number;
  baseSeed: number;
  checkpoint: string;
  learned: {
    wins: number;
    winRate: number;
    averageLevelGainOnWins: number;
  };
  legacy: {
    wins: number;
    winRate: number;
    averageLevelGainOnWins: number;
  };
}

interface PendingRequest {
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

class PythonPolicyClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private ready: Promise<void>;

  constructor(pythonBin: string, checkpoint: string) {
    this.child = spawn(pythonBin, ['training/danzero_mvp/serve_policy.py', '--checkpoint', checkpoint], {
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
      if (line.includes('"ready"')) {
        return;
      }

      const parsed = JSON.parse(line) as { id: number; chosen_index?: number; error?: string };
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

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
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`Policy server exited with code ${code ?? -1}.`));
      }
      this.pending.clear();
    });
  }

  async chooseActionIndex(input: ArenaTurnInput): Promise<number> {
    await this.ready;
    const requestId = this.nextId++;
    const encoded = encodeTurnForPolicy(input);

    return await new Promise<number>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({
          id: requestId,
          state_features: encoded.stateFeatures,
          action_features: encoded.actionFeatures,
        }) + '\n',
      );
    });
  }

  async close(): Promise<void> {
    if (this.child.killed) {
      return;
    }

    this.child.stdin.end();
    this.child.kill();
  }
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '20');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260413');
  const checkpoint = process.env.CHECKPOINT;
  const pythonBin = process.env.PYTHON_BIN ?? '.venv-danzero/bin/python';

  if (!checkpoint) {
    throw new Error('CHECKPOINT is required.');
  }

  const client = new PythonPolicyClient(pythonBin, checkpoint);
  let learnedWins = 0;
  let legacyWins = 0;
  let learnedLevelGain = 0;
  let legacyLevelGain = 0;

  try {
    for (let index = 0; index < matches; index += 1) {
      const learnedTeam = (index % 2 === 0 ? 0 : 1) as 0 | 1;
      const random = createSeededRandom(baseSeed + index);
      const learnedAgent = buildLearnedAgent(client);
      const match = new GuandanArenaMatch({
        initialState: createNewGame(random),
        agents:
          learnedTeam === 0
            ? [
                learnedAgent,
                createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 1' }),
                learnedAgent,
                createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 3' }),
              ]
            : [
                createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 0' }),
                learnedAgent,
                createHeuristicAgent({ profile: 'legacy-v1', label: 'Legacy 2' }),
                learnedAgent,
              ],
      });

      const finalState = await match.runUntilFinished({ maxTurns: 500 });
      if (!finalState.result) {
        throw new Error(`Match ${index + 1} finished without a result.`);
      }

      if (finalState.result.winnerTeam === learnedTeam) {
        learnedWins += 1;
        learnedLevelGain += finalState.result.levelDelta;
      } else {
        legacyWins += 1;
        legacyLevelGain += finalState.result.levelDelta;
      }
    }
  } finally {
    await client.close();
  }

  const summary: EvalSummary = {
    matches,
    baseSeed,
    checkpoint,
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

  console.log(JSON.stringify(summary, null, 2));
}

function buildLearnedAgent(client: PythonPolicyClient): GuandanArenaAgent {
  return createFunctionAgent({
    id: 'learned-policy',
    label: 'DanZero MVP',
    async decideTurn(input): Promise<ArenaChosenAction> {
      const chosenIndex = await client.chooseActionIndex(input);
      const chosen = input.legalActions[chosenIndex] ?? input.legalActions[0];

      if (!chosen) {
        throw new Error('No legal actions available for learned agent.');
      }

      if (chosen.kind === 'pass') {
        return { kind: 'pass' };
      }

      return {
        kind: 'play',
        actionId: chosen.actionId,
      };
    },
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

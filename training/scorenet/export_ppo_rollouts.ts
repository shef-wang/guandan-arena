declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { applyArenaChosenAction, buildArenaTurnInput } from '../../src/arena/engine';
import { createSeededRandom } from '../../src/game/cards';
import { chooseAiAction, type AiProfile } from '../../src/game/ai';
import { createNewGame } from '../../src/game/state';
import type { AiDecision, GameState, Seat } from '../../src/game/types';
import type { ArenaChosenAction } from '../../src/arena/types';
import { buildHeuristicContext, encodeTurnForPolicy } from './feature_codec';

interface PolicyResponse {
  chosen_index: number;
  chosen_log_prob: number;
  value: number;
  entropy: number;
}

interface PendingRequest {
  resolve: (value: PolicyResponse) => void;
  reject: (error: Error) => void;
}

interface PendingTransition {
  stateFeatures: number[];
  actionFeatures: number[][];
  chosenActionIndex: number;
  oldLogProb: number;
  oldValue: number;
  entropy: number;
}

interface SerializedTransition {
  state_features: number[];
  action_features: number[][];
  chosen_action_index: number;
  old_log_prob: number;
  old_value: number;
  target_return: number;
  advantage: number;
  entropy: number;
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
    this.child = spawn(pythonBin, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });

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
          reject(new Error(parsed.error ?? `Unexpected policy server hello: ${line}`));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Unable to parse policy server hello.'));
        }
      });
    });

    stdout.on('line', (line) => {
      if (line.includes('"ready"')) return;
      const parsed = JSON.parse(line) as { id: number; error?: string } & Partial<PolicyResponse>;
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error));
        return;
      }
      pending.resolve({
        chosen_index: parsed.chosen_index ?? 0,
        chosen_log_prob: parsed.chosen_log_prob ?? 0,
        value: parsed.value ?? 0,
        entropy: parsed.entropy ?? 0,
      });
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

  async chooseAction(state: GameState, seat: Seat, temperature: number): Promise<PolicyResponse> {
    await this.ready;
    const requestId = this.nextId++;
    const input = buildArenaTurnInput(state, seat);
    const heuristic = buildHeuristicContext(state, seat);
    const encoded = encodeTurnForPolicy(input, heuristic);

    return await new Promise<PolicyResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({
          id: requestId,
          state_features: encoded.stateFeatures,
          action_features: encoded.actionFeatures,
          sample: true,
          temperature,
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

type SeatRole = 'learner' | 'frozen' | 'heuristic';
type RolloutRegime =
  | 'heuristic'
  | 'frozen_teammate'
  | 'selfplay_2v2'
  | 'selfplay_solo'
  | 'selfplay_mixed'
  | 'hybrid_selfplay_legacy';

type HybridSubMode = 'hybrid_heuristic' | 'hybrid_self_current' | 'hybrid_self_prior';

interface SeatPlan {
  roles: Record<Seat, SeatRole>;
  frozenSeatToCheckpoint: Partial<Record<Seat, string>>;
  regimeUsed: RolloutRegime;
  hybridSubMode?: HybridSubMode;
}

function parseFrozenPool(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function pickFrozen(pool: string[], rng: () => number): string {
  if (pool.length === 0) {
    throw new Error('Frozen pool is empty but a frozen role was selected.');
  }
  const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[idx]!;
}

/**
 * Rollout env (export_ppo_rollouts / selfplay_loop):
 * - ROLLOUT_REGIME=hybrid_selfplay_legacy: per match, HYBRID_LEGACY_FRACTION (default 0.2) vs legacy-v3.0
 *   (OPPONENT_PROFILE); else symmetric selfplay 2v2. Mirror opponents use CHECKPOINT; with probability
 *   FROZEN_PRIOR_PROB (default 0.2) and non-empty FROZEN_PRIOR_CHECKPOINTS, both frozen seats use one prior snapshot.
 * - SELFPLAY_2V2_SYMMETRIC=1: for selfplay_2v2, same checkpoint for seats 1 and 3 (one draw from FROZEN_POOL_CHECKPOINTS).
 */
function planSeats(
  regime: RolloutRegime,
  frozenPool: string[],
  frozenPartnerProb: number,
  rng: () => number,
  opts: {
    currentCheckpoint: string;
    priorPool: string[];
    hybridLegacyFraction: number;
    priorProb: number;
    selfplay2v2Symmetric: boolean;
  },
): SeatPlan {
  const roles: Record<Seat, SeatRole> = { 0: 'learner', 1: 'heuristic', 2: 'learner', 3: 'heuristic' };
  const frozenSeatToCheckpoint: Partial<Record<Seat, string>> = {};

  if (regime === 'hybrid_selfplay_legacy') {
    if (rng() < opts.hybridLegacyFraction) {
      return { roles, frozenSeatToCheckpoint, regimeUsed: 'heuristic', hybridSubMode: 'hybrid_heuristic' };
    }
    roles[1] = 'frozen';
    roles[3] = 'frozen';
    const usePrior = opts.priorPool.length > 0 && rng() < opts.priorProb;
    const mirrorCk = usePrior
      ? pickFrozen(opts.priorPool, rng)
      : opts.currentCheckpoint;
    frozenSeatToCheckpoint[1] = mirrorCk;
    frozenSeatToCheckpoint[3] = mirrorCk;
    return {
      roles,
      frozenSeatToCheckpoint,
      regimeUsed: 'selfplay_2v2',
      hybridSubMode: usePrior ? 'hybrid_self_prior' : 'hybrid_self_current',
    };
  }

  let effective: RolloutRegime = regime;
  if (regime === 'selfplay_mixed') {
    effective = rng() < 0.5 ? 'selfplay_2v2' : 'selfplay_solo';
  }

  switch (effective) {
    case 'hybrid_selfplay_legacy':
      break;
    case 'heuristic':
      break;
    case 'frozen_teammate':
      if (frozenPool.length > 0 && rng() < frozenPartnerProb) {
        roles[2] = 'frozen';
        frozenSeatToCheckpoint[2] = pickFrozen(frozenPool, rng);
      }
      break;
    case 'selfplay_2v2':
      roles[1] = 'frozen';
      roles[3] = 'frozen';
      if (opts.selfplay2v2Symmetric && frozenPool.length > 0) {
        const ck = pickFrozen(frozenPool, rng);
        frozenSeatToCheckpoint[1] = ck;
        frozenSeatToCheckpoint[3] = ck;
      } else {
        frozenSeatToCheckpoint[1] = pickFrozen(frozenPool, rng);
        frozenSeatToCheckpoint[3] = pickFrozen(frozenPool, rng);
      }
      break;
    case 'selfplay_solo':
      roles[1] = 'frozen';
      roles[2] = 'frozen';
      roles[3] = 'frozen';
      frozenSeatToCheckpoint[1] = pickFrozen(frozenPool, rng);
      frozenSeatToCheckpoint[2] = pickFrozen(frozenPool, rng);
      frozenSeatToCheckpoint[3] = pickFrozen(frozenPool, rng);
      break;
    default:
      break;
  }

  return { roles, frozenSeatToCheckpoint, regimeUsed: effective };
}

async function main(): Promise<void> {
  // When stderr is a pipe, Node may full-buffer; rollout progress then appears only at exit. Unblock.
  for (const stream of [process.stdout, process.stderr] as const) {
    if (!stream.isTTY) {
      const handle = (stream as NodeJS.WriteStream & { _handle?: { setBlocking?: (v: boolean) => void } })._handle;
      handle?.setBlocking?.(true);
    }
  }

  const matches = Number(process.env.MATCHES ?? '200');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260416');
  const checkpoint = process.env.CHECKPOINT;
  const outputPath = process.env.OUTPUT_PATH ?? 'training/scorenet/data/selfplay_ppo_rollout.jsonl';
  const pythonBin = process.env.PYTHON_BIN ?? '.venv-danzero/bin/python';
  const temperature = Number(process.env.TEMPERATURE ?? '0.9');
  const cpuFraction = Number(process.env.CPU_FRACTION ?? '0.8');
  const mpsMemoryFraction = Number(process.env.MPS_MEMORY_FRACTION ?? '0.8');
  const scoreNetDevice = process.env.SCORENET_DEVICE ?? null;
  const gaeLambda = Number(process.env.GAE_LAMBDA ?? '0.95');
  const gamma = Number(process.env.GAMMA ?? '1.0');
  const opponentProfile = (process.env.OPPONENT_PROFILE ?? 'legacy-v3.0') as AiProfile;
  const workerId = process.env.ROLLOUT_WORKER_ID ?? 'main';
  const progressEveryRaw = Number(process.env.PROGRESS_EVERY_MATCHES ?? '10');
  const progressEveryMatches = Number.isFinite(progressEveryRaw) ? Math.max(0, Math.floor(progressEveryRaw)) : 10;
  const regime = ((process.env.ROLLOUT_REGIME ?? 'heuristic') as RolloutRegime);
  const frozenPool = parseFrozenPool(process.env.FROZEN_POOL_CHECKPOINTS);
  const priorPool = parseFrozenPool(process.env.FROZEN_PRIOR_CHECKPOINTS);
  const frozenPartnerProb = Number(process.env.FROZEN_PARTNER_PROB ?? '0');
  const hybridLegacyFraction = Number.isFinite(Number(process.env.HYBRID_LEGACY_FRACTION))
    ? Math.min(1, Math.max(0, Number(process.env.HYBRID_LEGACY_FRACTION)))
    : 0.2;
  const priorProb = Number.isFinite(Number(process.env.FROZEN_PRIOR_PROB))
    ? Math.min(1, Math.max(0, Number(process.env.FROZEN_PRIOR_PROB)))
    : 0.2;
  const selfplay2v2Symmetric = (process.env.SELFPLAY_2V2_SYMMETRIC ?? '0') === '1';
  const frozenPoolDevice = process.env.FROZEN_POOL_DEVICE ?? scoreNetDevice;
  const frozenSampleTemperature = Number(process.env.FROZEN_POOL_TEMPERATURE ?? String(temperature));

  if (!checkpoint) {
    throw new Error('CHECKPOINT is required.');
  }
  if (regime === 'hybrid_selfplay_legacy') {
    if (hybridLegacyFraction < 0 || hybridLegacyFraction > 1) {
      throw new Error('HYBRID_LEGACY_FRACTION must be in [0,1].');
    }
  } else if (regime !== 'heuristic' && frozenPool.length === 0) {
    throw new Error(`ROLLOUT_REGIME=${regime} requires non-empty FROZEN_POOL_CHECKPOINTS.`);
  }

  const planOpts = {
    currentCheckpoint: checkpoint,
    priorPool,
    hybridLegacyFraction,
    priorProb,
    selfplay2v2Symmetric,
  };

  const uniqueFrozenPaths = new Set<string>(frozenPool);
  if (regime === 'hybrid_selfplay_legacy') {
    uniqueFrozenPaths.add(checkpoint);
    for (const p of priorPool) {
      uniqueFrozenPaths.add(p);
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const learnerClient = new PythonPolicyClient(pythonBin, checkpoint, cpuFraction, mpsMemoryFraction, scoreNetDevice);
  const frozenClients = new Map<string, PythonPolicyClient>();
  for (const ckpt of uniqueFrozenPaths) {
    if (!frozenClients.has(ckpt)) {
      frozenClients.set(ckpt, new PythonPolicyClient(pythonBin, ckpt, cpuFraction, mpsMemoryFraction, frozenPoolDevice));
    }
  }
  const lines: string[] = [];
  let totalTurns = 0;
  let team0Wins = 0;
  let team1Wins = 0;
  let frozenMatchCount = 0;
  const regimeCounts: Partial<Record<RolloutRegime, number>> = {};
  const hybridSubCounts: Partial<Record<HybridSubMode, number>> = {};
  const startedAt = Date.now();

  try {
    for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
      const random = createSeededRandom(baseSeed + matchIndex);
      const planRng = createSeededRandom(baseSeed + matchIndex + 7919);
      const plan = planSeats(regime, frozenPool, frozenPartnerProb, planRng, planOpts);
      regimeCounts[plan.regimeUsed] = (regimeCounts[plan.regimeUsed] ?? 0) + 1;
      if (plan.hybridSubMode) {
        hybridSubCounts[plan.hybridSubMode] = (hybridSubCounts[plan.hybridSubMode] ?? 0) + 1;
      }
      if ((Object.values(plan.roles) as SeatRole[]).includes('frozen')) frozenMatchCount += 1;

      let state = createNewGame(random);
      const pending: PendingTransition[] = [];
      let turnCount = 0;

      while (!state.result) {
        const seat = state.currentPlayer;
        const role = plan.roles[seat];
        if (role === 'learner') {
          const input = buildArenaTurnInput(state, seat);
          const sampled = await learnerClient.chooseAction(state, seat, temperature);
          const chosenIndex = Math.max(0, Math.min(sampled.chosen_index, input.legalActions.length - 1));
          const chosenAction = input.legalActions[chosenIndex] ?? input.legalActions[0];
          if (!chosenAction) {
            throw new Error(`No legal actions for learner seat ${seat}`);
          }

          const heuristic = buildHeuristicContext(state, seat);
          const encoded = encodeTurnForPolicy(input, heuristic);
          pending.push({
            stateFeatures: encoded.stateFeatures,
            actionFeatures: encoded.actionFeatures,
            chosenActionIndex: chosenIndex,
            oldLogProb: sampled.chosen_log_prob,
            oldValue: sampled.value,
            entropy: sampled.entropy,
          });

          const arenaAction: ArenaChosenAction =
            chosenAction.kind === 'pass' ? { kind: 'pass' } : { kind: 'play', actionId: chosenAction.actionId };
          state = applyArenaChosenAction(state, seat, arenaAction);
        } else if (role === 'frozen') {
          const ckpt = plan.frozenSeatToCheckpoint[seat];
          if (!ckpt) throw new Error(`Frozen role on seat ${seat} but no checkpoint assigned.`);
          const frozenClient = frozenClients.get(ckpt);
          if (!frozenClient) throw new Error(`Frozen client missing for ${ckpt}`);
          const input = buildArenaTurnInput(state, seat);
          const sampled = await frozenClient.chooseAction(state, seat, frozenSampleTemperature);
          const chosenIndex = Math.max(0, Math.min(sampled.chosen_index, input.legalActions.length - 1));
          const chosenAction = input.legalActions[chosenIndex] ?? input.legalActions[0];
          if (!chosenAction) throw new Error(`No legal actions for frozen seat ${seat}`);
          const arenaAction: ArenaChosenAction =
            chosenAction.kind === 'pass' ? { kind: 'pass' } : { kind: 'play', actionId: chosenAction.actionId };
          state = applyArenaChosenAction(state, seat, arenaAction);
        } else {
          const decision = chooseAiAction(state, seat, opponentProfile);
          state = applyArenaChosenAction(state, seat, toArenaChosenAction(decision));
        }
        turnCount += 1;
      }

      totalTurns += turnCount;
      if (!state.result) throw new Error(`Match ${matchIndex + 1} ended without result`);
      if (state.result.winnerTeam === 0) team0Wins += 1;
      else team1Wins += 1;
      const terminalReturn = state.result.winnerTeam === 0 ? state.result.levelDelta : -state.result.levelDelta;
      computeGAEAndAppend(pending, terminalReturn, gamma, gaeLambda, lines);

      const completed = matchIndex + 1;
      if (progressEveryMatches > 0 && (completed % progressEveryMatches === 0 || completed === matches)) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rate = completed > 0 ? elapsedSec / completed : 0;
        const etaSec = Math.max(0, (matches - completed) * rate);
        console.error(
          `[rollout w${workerId}] ${completed}/${matches} matches, samples=${lines.length}, avgTurns=${(totalTurns / completed).toFixed(2)}, elapsed=${elapsedSec.toFixed(1)}s, eta=${etaSec.toFixed(1)}s`,
        );
      }
    }
  } finally {
    await learnerClient.close();
    for (const client of frozenClients.values()) {
      await client.close();
    }
  }

  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        matches,
        baseSeed,
        checkpoint,
        outputPath,
        sampleCount: lines.length,
        averageTurnsPerMatch: matches > 0 ? totalTurns / matches : 0,
        team0Wins,
        team1Wins,
        temperature,
        opponentProfile,
        regime,
        regimeCounts,
        hybridSubCounts: regime === 'hybrid_selfplay_legacy' ? hybridSubCounts : undefined,
        hybridLegacyFraction: regime === 'hybrid_selfplay_legacy' ? hybridLegacyFraction : undefined,
        priorProb: regime === 'hybrid_selfplay_legacy' ? priorProb : undefined,
        priorPoolSize: regime === 'hybrid_selfplay_legacy' ? priorPool.length : undefined,
        frozenPoolSize: frozenPool.length,
        frozenMatchCount,
        frozenPartnerProb,
        selfplay2v2Symmetric,
      },
      null,
      2,
    ),
  );
}

function computeGAEAndAppend(
  steps: PendingTransition[],
  terminalReturn: number,
  gamma: number,
  gaeLambda: number,
  lines: string[],
): void {
  if (steps.length === 0) return;
  const T = steps.length;
  const advantages = new Array<number>(T);
  const returns = new Array<number>(T);
  let gae = 0;

  for (let t = T - 1; t >= 0; t -= 1) {
    const reward = t === T - 1 ? terminalReturn : 0;
    const nextValue = t === T - 1 ? 0 : steps[t + 1].oldValue;
    const delta = reward + gamma * nextValue - steps[t].oldValue;
    gae = delta + gamma * gaeLambda * gae;
    advantages[t] = gae;
    returns[t] = gae + steps[t].oldValue;
  }

  for (let t = 0; t < T; t += 1) {
    const row: SerializedTransition = {
      state_features: steps[t].stateFeatures,
      action_features: steps[t].actionFeatures,
      chosen_action_index: steps[t].chosenActionIndex,
      old_log_prob: steps[t].oldLogProb,
      old_value: steps[t].oldValue,
      target_return: returns[t],
      advantage: advantages[t],
      entropy: steps[t].entropy,
    };
    lines.push(JSON.stringify(row));
  }
}

function toArenaChosenAction(decision: AiDecision): ArenaChosenAction {
  if (decision.type === 'pass') {
    return { kind: 'pass' };
  }
  return { kind: 'play', actionId: `play:${decision.play!.key}` };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

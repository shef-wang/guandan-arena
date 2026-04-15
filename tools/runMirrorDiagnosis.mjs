import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  throw new Error('Missing OPENROUTER_API_KEY');
}

const model = process.env.OPENROUTER_MODEL?.trim() || 'moonshotai/kimi-k2.5';
const opponentProfile = process.env.OPENROUTER_OPPONENT_PROFILE?.trim() || 'legacy-v1';
const timeoutMs = process.env.OPENROUTER_TIMEOUT_MS?.trim() || '15000';
const baseSeed = process.env.BASE_SEED?.trim() || '20260413';
const includeTrace = process.env.OUTPUT_TRACE !== '0';
const outputPath = process.env.DIAGNOSE_OUTPUT_PATH?.trim();

const cwd = process.cwd();
const runnerPath = path.resolve(cwd, '.codex-runner-cjs/arena/runHeadlessMatch.js');

if (!fs.existsSync(runnerPath)) {
  throw new Error(`Missing runner bundle at ${runnerPath}. Rebuild the headless runner first.`);
}

const evenRun = await runOneSide('team0', '0');
const oddRun = await runOneSide('team1', '1');

const diagnosis = {
  model,
  opponentProfile,
  baseSeed: Number(baseSeed),
  timeoutMs: Number(timeoutMs),
  comparison: {
    llmAsTeam0: summarizeRun(evenRun),
    llmAsTeam1: summarizeRun(oddRun),
    betterSide: pickBetterSide(evenRun, oddRun),
  },
  runs: {
    llmAsTeam0: evenRun,
    llmAsTeam1: oddRun,
  },
};

const output = JSON.stringify(diagnosis, null, 2);

if (outputPath) {
  fs.writeFileSync(path.resolve(cwd, outputPath), output);
}

console.log(output);

async function runOneSide(label, team) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [runnerPath], {
    cwd,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: apiKey,
      OPENROUTER_MODEL: model,
      OPENROUTER_OPPONENT_PROFILE: opponentProfile,
      OPENROUTER_TIMEOUT_MS: timeoutMs,
      OPENROUTER_TEAM: team,
      BASE_SEED: baseSeed,
      MATCHES: '1',
      OUTPUT_TRACE: includeTrace ? '1' : '0',
    },
    maxBuffer: 20 * 1024 * 1024,
  });

  if (stderr?.trim()) {
    process.stderr.write(stderr);
  }

  const parsed = JSON.parse(stdout);
  return {
    side: label,
    ...parsed,
  };
}

function summarizeRun(run) {
  const signedLevelDelta = run.result ? (run.result.winnerTeam === run.llmTeam.team ? run.result.levelDelta : -run.result.levelDelta) : 0;
  return {
    llmTeam: run.llmTeam,
    result: run.result,
    turns: run.turns,
    signedLevelDelta,
    totalTokens: run.usage?.total?.totalTokens ?? 0,
    requests: run.usage?.total?.requests ?? 0,
  };
}

function pickBetterSide(evenRun, oddRun) {
  const evenScore = summarizeRun(evenRun).signedLevelDelta;
  const oddScore = summarizeRun(oddRun).signedLevelDelta;

  if (evenScore > oddScore) {
    return 'llmAsTeam0';
  }

  if (oddScore > evenScore) {
    return 'llmAsTeam1';
  }

  return 'tie';
}

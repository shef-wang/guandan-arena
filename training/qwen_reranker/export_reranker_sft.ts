declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSeededRandom } from '../../src/game/cards';
import { createNewGame } from '../../src/game/state';
import { chooseAiAction, rankLegacyV1ActionCandidates } from '../../src/game/ai';
import { buildArenaTurnInput, applyArenaChosenAction } from '../../src/arena/engine';
import { formatArenaLlmSystemPrompt, formatTurnInputAsPrompt } from '../../src/arena/prompt';
import type { ArenaChosenAction } from '../../src/arena/types';

interface SFTSample {
  messages: Array<{ role: string; content: string }>;
}

async function main(): Promise<void> {
  const matches = Number(process.env.MATCHES ?? '500');
  const baseSeed = Number(process.env.BASE_SEED ?? '20260413');
  const outputPath = process.env.OUTPUT_PATH ?? 'training/qwen_reranker/data/sft.jsonl';
  const topK = Number(process.env.TOP_K ?? '6');

  mkdirSync(dirname(outputPath), { recursive: true });
  const lines: string[] = [];
  let totalTurns = 0;

  for (let matchIndex = 0; matchIndex < matches; matchIndex++) {
    const random = createSeededRandom(baseSeed + matchIndex);
    let state = createNewGame(random);

    while (!state.result) {
      const seat = state.currentPlayer;
      const input = buildArenaTurnInput(state, seat);

      if (input.legalActions.length > 2) {
        const ranked = rankLegacyV1ActionCandidates(state, seat);
        const teacherDecision = chooseAiAction(state, seat, 'legacy-v1');

        let teacherAction: ArenaChosenAction;
        if (teacherDecision.type === 'pass' || !teacherDecision.play) {
          teacherAction = { kind: 'pass' };
        } else {
          teacherAction = { kind: 'play', actionId: `play:${teacherDecision.play.key}` };
        }

        const candidates = ranked.slice(0, topK).map((c, i) => {
          if (c.type === 'pass') {
            return { rank: i + 1, action: { kind: 'pass' as const }, label: 'Pass', score: c.score };
          }
          return {
            rank: i + 1,
            action: { kind: 'play' as const, actionId: `play:${c.play!.key}` },
            label: c.play!.label,
            score: c.score,
          };
        });

        const systemPrompt = [
          formatArenaLlmSystemPrompt(input),
          'You are reranking candidate actions from a legacy heuristic.',
          'Choose the best action from the candidates below.',
        ].join(' ');

        const userPrompt = [
          'Candidates:',
          ...candidates.map((c) => `  #${c.rank} ${c.label} score=${c.score} action=${JSON.stringify(c.action)}`),
          '',
          'Game state:',
          formatTurnInputAsPrompt(input),
          '',
          'Reply with exactly one JSON action object.',
        ].join('\n');

        const sample: SFTSample = {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: JSON.stringify(teacherAction) },
          ],
        };

        lines.push(JSON.stringify(sample));
      }

      const decision = chooseAiAction(state, seat, 'legacy-v1');
      if (decision.type === 'pass' || !decision.play) {
        state = applyArenaChosenAction(state, seat, { kind: 'pass' });
      } else {
        state = applyArenaChosenAction(state, seat, { kind: 'play', actionId: `play:${decision.play.key}` });
      }
      totalTurns++;
    }
  }

  writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({
    matches,
    baseSeed,
    outputPath,
    sampleCount: lines.length,
    averageTurnsPerMatch: matches > 0 ? totalTurns / matches : 0,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

import { buildHeuristicContext, encodeTurnForPolicy } from '../../training/scorenet/feature_codec';
import type { Seat } from '../game/types';
import { createLearnedPolicyAgent } from './learnedPolicyAgent';
import type { ArenaChosenAction, GuandanArenaAgent } from './types';

interface ScoreNetChoiceResponse {
  chosen_index?: number;
  checkpoint?: string;
  error?: string;
}

export interface ScoreNetSeatAgentConfig {
  id: string;
  label: string;
  seat: Seat;
}

export function createScoreNetSeatAgent(config: ScoreNetSeatAgentConfig): GuandanArenaAgent {
  return createLearnedPolicyAgent({
    id: config.id,
    label: config.label,
    async evaluate(input, context) {
      const heuristic = buildHeuristicContext(context.state, context.seat);
      const encoded = encodeTurnForPolicy(input, heuristic);

      const response = await fetch('/api/scorenet/choose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stateFeatures: encoded.stateFeatures,
          actionFeatures: encoded.actionFeatures,
        }),
      });

      const choice = (await response.json()) as ScoreNetChoiceResponse;
      if (!response.ok || choice.error) {
        throw new Error(choice.error ?? `ScoreNet HTTP ${response.status}`);
      }

      const chosenIndex = Math.max(0, Math.min(choice.chosen_index ?? 0, input.legalActions.length - 1));
      const chosen = input.legalActions[chosenIndex] ?? input.legalActions[0];
      if (!chosen) {
        throw new Error('ScoreNet returned no legal action.');
      }

      const action: ArenaChosenAction =
        chosen.kind === 'pass' ? { kind: 'pass' } : { kind: 'play', actionId: chosen.actionId };
      return action;
    },
  });
}

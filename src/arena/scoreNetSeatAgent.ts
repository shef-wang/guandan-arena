import { buildHeuristicContext, encodeTurnForPolicy } from '../../training/scorenet/feature_codec';
import type { Seat } from '../game/types';
import { createLearnedPolicyAgent } from './learnedPolicyAgent';
import { scoreNetChooseIndex } from './scoreNetBrowserSession';
import type { ArenaChosenAction, GuandanArenaAgent } from './types';

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

      const choice = await scoreNetChooseIndex(encoded.stateFeatures, encoded.actionFeatures);

      const chosenIndex = Math.max(0, Math.min(choice.chosen_index, input.legalActions.length - 1));
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

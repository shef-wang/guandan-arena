import type { ArenaChosenAction, ArenaTurnInput, ArenaTurnContext, GuandanArenaAgent } from './types';

export interface HumanAgentConfig {
  id: string;
  label: string;
  onDecisionNeeded: (
    input: ArenaTurnInput,
    context: ArenaTurnContext,
  ) => Promise<ArenaChosenAction>;
}

/**
 * Creates an agent backed by a human decision-maker.
 * The `onDecisionNeeded` callback is invoked when it's this seat's turn;
 * it should resolve once the human has chosen an action (e.g. via WebSocket
 * round-trip or UI interaction).
 */
export function createHumanAgent(config: HumanAgentConfig): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    agentType: 'human',
    decideTurn(input, context) {
      return config.onDecisionNeeded(input, context);
    },
  };
}

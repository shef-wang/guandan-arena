import type { ArenaChosenAction, ArenaTurnInput, ArenaTurnContext, GuandanArenaAgent } from './types';

export interface LearnedPolicyAgentConfig {
  id: string;
  label: string;
  /** Evaluate state+actions and return the chosen action index or ArenaChosenAction. */
  evaluate: (
    input: ArenaTurnInput,
    context: ArenaTurnContext,
  ) => Promise<ArenaChosenAction>;
}

/**
 * Creates an agent backed by a learned policy (e.g. a neural net served
 * via `serve_policy.py` or any other inference backend).
 *
 * The `evaluate` callback encapsulates encoding, communication with the
 * policy server, and decoding the response back into an ArenaChosenAction.
 */
export function createLearnedPolicyAgent(config: LearnedPolicyAgentConfig): GuandanArenaAgent {
  return {
    id: config.id,
    label: config.label,
    agentType: 'learned-policy',
    decideTurn(input, context) {
      return config.evaluate(input, context);
    },
  };
}

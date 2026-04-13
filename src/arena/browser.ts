import {
  ARENA_RULES_SUMMARY,
  GuandanArenaMatch,
  applyArenaChosenAction,
  buildArenaTurnInput,
  createFunctionAgent,
  createHeuristicAgent,
  createPromptAgent,
  getLegalActionsForSeat,
  parseArenaChosenAction,
  validateArenaChosenAction,
} from './engine';
import { createOpenRouterAgent } from './openrouter';
import type { GameState, Seat } from '../game/types';
import { formatTurnInputAsPrompt } from './prompt';
import type { ArenaChosenAction, ArenaMatchConfig, GuandanArenaAgent } from './types';

export interface BrowserGuandanArenaApi {
  version: string;
  rules: typeof ARENA_RULES_SUMMARY;
  createFunctionAgent: typeof createFunctionAgent;
  createHeuristicAgent: typeof createHeuristicAgent;
  createPromptAgent: typeof createPromptAgent;
  createOpenRouterAgent: typeof createOpenRouterAgent;
  createMatch: (config: ArenaMatchConfig) => GuandanArenaMatch;
  formatTurnInputAsPrompt: typeof formatTurnInputAsPrompt;
  buildTurnInput: typeof buildArenaTurnInput;
  getLegalActions: typeof getLegalActionsForSeat;
  parseChosenAction: typeof parseArenaChosenAction;
  validateChosenAction: typeof validateArenaChosenAction;
  applyChosenAction: (state: GameState, seat: Seat, action: ArenaChosenAction) => GameState;
  registerAgent: (agent: GuandanArenaAgent) => void;
  unregisterAgent: (id: string) => void;
  getRegisteredAgent: (id: string) => GuandanArenaAgent | null;
  listRegisteredAgents: () => Array<{ id: string; label: string }>;
}

declare global {
  interface Window {
    guandanArena?: BrowserGuandanArenaApi;
  }
}

export function installGuandanArenaBridge(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const registeredAgents = new Map<string, GuandanArenaAgent>();

  const api: BrowserGuandanArenaApi = {
    version: '0.1.0',
    rules: ARENA_RULES_SUMMARY,
    createFunctionAgent,
    createHeuristicAgent,
    createPromptAgent,
    createOpenRouterAgent,
    createMatch(config: ArenaMatchConfig) {
      return new GuandanArenaMatch(config);
    },
    formatTurnInputAsPrompt,
    buildTurnInput: buildArenaTurnInput,
    getLegalActions: getLegalActionsForSeat,
    parseChosenAction: parseArenaChosenAction,
    validateChosenAction: validateArenaChosenAction,
    applyChosenAction: applyArenaChosenAction,
    registerAgent(agent: GuandanArenaAgent) {
      registeredAgents.set(agent.id, agent);
    },
    unregisterAgent(id: string) {
      registeredAgents.delete(id);
    },
    getRegisteredAgent(id: string) {
      return registeredAgents.get(id) ?? null;
    },
    listRegisteredAgents() {
      return [...registeredAgents.values()].map((agent) => ({
        id: agent.id,
        label: agent.label,
      }));
    },
  };

  window.guandanArena = api;
}

export type { ArenaMatchConfig, GuandanArenaAgent };

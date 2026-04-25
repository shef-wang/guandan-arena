import { chooseAiAction, type AiProfile } from '../game/ai';
import type { AiDecision, GameState, Seat } from '../game/types';

interface LegacyAiWorkerRequest {
  id: number;
  state: GameState;
  seat: Seat;
  profile: AiProfile;
}

interface LegacyAiWorkerResponse {
  id: number;
  decision: AiDecision;
}

self.onmessage = (event: MessageEvent<LegacyAiWorkerRequest>) => {
  const { id, state, seat, profile } = event.data;
  const decision = chooseAiAction(state, seat, profile);
  const response: LegacyAiWorkerResponse = {
    id,
    decision,
  };
  self.postMessage(response);
};

import { createSeededRandom } from '../src/game/cards';
import { createNewGame } from '../src/game/state';
import type { GameResult, GameState, Seat } from '../src/game/types';
import {
  buildArenaTurnInput,
  applyArenaChosenAction,
  createHeuristicAgent,
  GuandanArenaMatch,
  getLegalActionsForSeat,
} from '../src/arena/engine';
import type { ArenaChosenAction, ArenaTurnInput, GuandanArenaAgent } from '../src/arena/types';
import type { RoomConfig, SeatAssignment, RoomStateView } from './protocol';

type TurnResolver = (action: ArenaChosenAction) => void;

export class GameRoom {
  readonly roomId: string;
  readonly config: RoomConfig;
  private match: GuandanArenaMatch;
  private agents: Record<Seat, GuandanArenaAgent>;
  private humanResolvers: Map<Seat, TurnResolver> = new Map();
  private spectatorCallbacks: Set<(msg: unknown) => void> = new Set();
  private connectedHumans: Map<Seat, string> = new Map();
  private _finished = false;

  constructor(roomId: string, config: RoomConfig) {
    this.roomId = roomId;
    this.config = config;

    const rng = config.seed != null ? createSeededRandom(config.seed) : undefined;
    const initialState = createNewGame(rng);

    this.agents = {
      0: this.buildAgent(0, config.seatAssignments[0]),
      1: this.buildAgent(1, config.seatAssignments[1]),
      2: this.buildAgent(2, config.seatAssignments[2]),
      3: this.buildAgent(3, config.seatAssignments[3]),
    };

    this.match = new GuandanArenaMatch({
      agents: [this.agents[0], this.agents[1], this.agents[2], this.agents[3]],
      initialState,
    });
  }

  get finished(): boolean {
    return this._finished;
  }

  getState(): GameState {
    return this.match.getState();
  }

  getStateView(): RoomStateView {
    const state = this.match.getState();
    return {
      seats: ([0, 1, 2, 3] as const).map((seat) => ({
        seat,
        assignment: this.config.seatAssignments[seat],
        connected: this.config.seatAssignments[seat].type === 'human'
          ? this.connectedHumans.has(seat)
          : true,
      })),
      gameStarted: true,
      currentPlayer: state.currentPlayer,
      message: state.message,
      finishOrder: [...state.finishOrder],
      result: state.result,
    };
  }

  getTurnInput(seat: Seat): ArenaTurnInput {
    return buildArenaTurnInput(this.match.getState(), seat);
  }

  connectHuman(seat: Seat, playerId: string): void {
    this.connectedHumans.set(seat, playerId);
  }

  disconnectHuman(seat: Seat): void {
    this.connectedHumans.delete(seat);
    const resolver = this.humanResolvers.get(seat);
    if (resolver) {
      resolver({ kind: 'pass' });
      this.humanResolvers.delete(seat);
    }
  }

  isHumanSeat(seat: Seat): boolean {
    return this.config.seatAssignments[seat].type === 'human';
  }

  submitHumanAction(seat: Seat, action: ArenaChosenAction): boolean {
    const resolver = this.humanResolvers.get(seat);
    if (!resolver) return false;
    this.humanResolvers.delete(seat);
    resolver(action);
    return true;
  }

  addSpectator(callback: (msg: unknown) => void): () => void {
    this.spectatorCallbacks.add(callback);
    return () => this.spectatorCallbacks.delete(callback);
  }

  broadcast(msg: unknown): void {
    for (const cb of this.spectatorCallbacks) {
      try { cb(msg); } catch { /* ignore broken callbacks */ }
    }
  }

  async runGameLoop(
    onTurnRequest: (seat: Seat, input: ArenaTurnInput) => void,
    onTurnPlayed: (seat: Seat, action: ArenaChosenAction, state: GameState) => void,
    onFinished: (result: GameResult, finishOrder: Seat[]) => void,
  ): Promise<void> {
    const maxTurns = 500;
    for (let turn = 0; turn < maxTurns; turn++) {
      const state = this.match.getState();
      if (state.result) {
        this._finished = true;
        onFinished(state.result, [...state.finishOrder]);
        return;
      }

      const seat = state.currentPlayer;

      if (this.isHumanSeat(seat)) {
        const input = this.getTurnInput(seat);
        onTurnRequest(seat, input);
      }

      const stepResult = await this.match.step();
      onTurnPlayed(stepResult.seat, stepResult.action, stepResult.nextState);
    }

    throw new Error(`Game exceeded ${maxTurns} turns.`);
  }

  private buildAgent(seat: Seat, assignment: SeatAssignment): GuandanArenaAgent {
    if (assignment.type === 'human') {
      return {
        id: `human-${assignment.playerId}-seat-${seat}`,
        label: `Human (${assignment.playerId})`,
        agentType: 'human',
        decideTurn: (_input, _context) => {
          return new Promise<ArenaChosenAction>((resolve) => {
            this.humanResolvers.set(seat, resolve);
          });
        },
      };
    }

    switch (assignment.agentType) {
      case 'heuristic':
      case 'openrouter':
      case 'learned-policy':
      case 'human':
      case 'custom':
      default:
        return createHeuristicAgent({
          id: assignment.agentId,
          label: `AI ${assignment.agentId}`,
          profile: 'legacy-v1',
        });
    }
  }
}

import type { ArenaTurnInput } from './types';

export function formatTurnInputAsPrompt(input: ArenaTurnInput): string {
  const payload = {
    knowledgeMode: input.knowledgeMode,
    rules: input.rules,
    seat: input.seat,
    currentPlayer: input.currentPlayer,
    message: input.message,
    result: input.result,
    players: input.players,
    hand: input.hand,
    currentTablePlay: input.currentTablePlay,
    roundTrace: input.roundTrace,
    finishOrder: input.finishOrder,
    publicKnowledge: input.publicKnowledge,
    legalActions: input.legalActions.map((action) => ({
      actionId: action.actionId,
      kind: action.kind,
      label: action.label,
      cardIds: action.cardIds,
    })),
  };

  return [
    'You are controlling one seat in the Guandan arena.',
    'This is a code-driven card game environment, not a vision task.',
    'This payload uses full public history mode.',
    'You can see your own hand plus the full public action history and all public counts.',
    'You cannot see other players hidden hands.',
    'Choose exactly one legal action from legalActions.',
    'Never invent a card combination outside legalActions.',
    'Return JSON only, with no markdown fences.',
    'Example pass: {"kind":"pass"}',
    'Example play: {"kind":"play","actionId":"play:pair-run:3:0:none"}',
    JSON.stringify(payload, null, 2),
  ].join('\n\n');
}

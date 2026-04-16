import type { ArenaTurnInput } from './types';

export function formatArenaLlmSystemPrompt(input: ArenaTurnInput): string {
  const teammateSeat = ((input.seat + 2) % 4) as 0 | 1 | 2 | 3;
  const ownTeam = input.players[input.seat]?.team ?? 0;
  const opponentSeats = ([0, 1, 2, 3] as const).filter((seat) => seat !== input.seat && seat !== teammateSeat);

  return [
    'You are an expert Guandan card game player in a competitive arena.',
    `You are seat S${input.seat} on team ${ownTeam}. Your teammate is S${teammateSeat}. Your opponents are S${opponentSeats.join(', ')}.`,
    '',
    'OBJECTIVE: Maximize your team\'s level gain. Finish order determines outcome.',
    `Finish outcomes from your team view: ${formatFinishOutcomesFromTeamView(input, ownTeam)}.`,
    '',
    'KEY RULES:',
    `Trump=${input.rules.trumpRank}. Wild=hearts-A only. Partnerships: S0+S2 vs S1+S3.`,
    'Bomb order: 4 jokers > 8-bomb > 7-bomb > 6-bomb > straight flush > 5-bomb > 4-bomb > ordinary plays.',
    'Straights: 10-J-Q-K-A, A-2-3-4-5, 2-3-4-5-6 allowed. Jokers cannot be in straights.',
    '',
    'STRATEGY GUIDELINES:',
    '- Lead with small plays to force opponents to use big cards.',
    '- Save bombs for critical moments (blocking opponents close to finishing).',
    '- Help your teammate finish early — pass when teammate leads if possible.',
    '- Track remaining cards: if opponents are low on cards, play aggressively.',
    '- Wild cards (hearts-A) are precious — avoid wasting on low-value plays.',
    '- When following, play the minimum needed to beat unless strategically beneficial.',
    '- When your teammate controls the table, consider passing to keep them in control.',
    '',
    'OUTPUT: Return exactly one JSON action: {"kind":"pass"} or {"kind":"play","actionId":"..."}',
  ].join('\n');
}

export function formatTurnInputAsPrompt(input: ArenaTurnInput): string {
  const teammateSeat = ((input.seat + 2) % 4) as 0 | 1 | 2 | 3;
  const ownTeam = input.players[input.seat]?.team ?? 0;
  const opponentSeats = ([0, 1, 2, 3] as const).filter((seat) => seat !== input.seat && seat !== teammateSeat);
  const legalActions = input.legalActions.map((action) => serializePromptAction(action));

  return [
    'Task',
    `Seat S${input.seat}, team ${ownTeam}. Teammate S${teammateSeat}. Opponents S${opponentSeats.join(', ')}.`,
    'Choose exactly one legal action from Legal Actions.',
    'Return JSON only: {"kind":"pass"} or {"kind":"play","actionId":"..."}',
    '',
    'State',
    `Message: ${input.message}`,
    `Current player: S${input.currentPlayer}`,
    `Table: ${formatCurrentTable(input)}`,
    `Finish order so far: ${input.finishOrder.length > 0 ? input.finishOrder.map((seat) => `S${seat}`).join(' > ') : 'none'}`,
    `Players: ${input.players.map(formatPlayerSummary).join(' | ')}`,
    `Round trace: ${formatRoundTraceSummary(input)}`,
    `Your hand (${input.hand.length}): ${input.hand.map(formatPromptCard).join(' ')}`,
    `Seen cards: ${summarizeSeenCards(input)}`,
    '',
    'Public Actions',
    formatRecentPublicActions(input),
    '',
    `Legal Actions (${legalActions.length})`,
    ...legalActions.map(formatLegalActionSummary),
  ].join('\n');
}

function serializePromptAction(action: ArenaTurnInput['legalActions'][number]) {
  if (action.kind === 'pass' || !action.play) {
    return {
      actionId: action.actionId,
      kind: action.kind,
      label: action.label,
      cardIds: action.cardIds,
      cards: [],
      playType: null,
      size: 0,
      primaryValue: null,
      bombSize: null,
      usesWild: false,
      wildCount: 0,
      suit: null,
      sequence: null,
    };
  }

  return {
    actionId: action.actionId,
    kind: action.kind,
    label: action.label,
    cardIds: action.cardIds,
    cards: action.play.cards.map((card) => formatPromptCard(card)),
    playType: action.play.type,
    size: action.play.size,
    primaryValue: action.play.primaryValue,
    bombSize: action.play.bombSize ?? null,
    usesWild: action.play.usesWild,
    wildCount: action.play.wildCount,
    suit: action.play.suit ?? null,
    sequence: action.play.sequence ?? null,
  };
}

function formatPromptCard(card: ArenaTurnInput['hand'][number]): string {
  const wildSuffix = card.isWild ? '*' : '';
  return `${card.rank}-${card.suit}${wildSuffix}`;
}

function formatFinishOutcomesFromTeamView(input: ArenaTurnInput, ownTeam: number): string {
  return input.rules.finishOutcomes
    .map((item) => `${item.placement}:${item.winnerTeam === ownTeam ? '+' : '-'}${item.levelDelta}`)
    .join(', ');
}

function formatCurrentTable(input: ArenaTurnInput): string {
  if (!input.currentTablePlay) {
    return 'lead play, no table play yet';
  }

  const { owner, play } = input.currentTablePlay;
  return `owner=S${owner}; ${formatPlaySummary(play)}`;
}

function formatPlaySummary(play: NonNullable<ArenaTurnInput['currentTablePlay']>['play']): string {
  return [
    `type=${play.type}`,
    `size=${play.size}`,
    `primary=${play.primaryValue}`,
    `bomb=${play.bombSize ?? '-'}`,
    `wild=${play.wildCount}`,
    `cards=${play.cards.map(formatPromptCard).join(' ')}`,
  ].join(', ');
}

function formatPlayerSummary(player: ArenaTurnInput['players'][number]): string {
  const finish = player.finishPosition ? `finish=${player.finishPosition}` : 'finish=-';
  return `S${player.seat}(T${player.team},hand=${player.handCount},${finish},last=${player.lastAction || '-'})`;
}

function formatRoundTraceSummary(input: ArenaTurnInput): string {
  return ([0, 1, 2, 3] as const)
    .map((seat) => {
      const trace = input.roundTrace[seat];
      return `S${seat}:${trace.action || '-'}`;
    })
    .join(' | ');
}

function summarizeSeenCards(input: ArenaTurnInput): string {
  if (input.publicKnowledge.seenCards.length === 0) {
    return 'none';
  }

  const rankCounts = new Map<string, number>();
  for (const card of input.publicKnowledge.seenCards) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
  }

  return [...rankCounts.entries()]
    .map(([rank, count]) => `${rank}x${count}`)
    .join(' ');
}

function formatRecentPublicActions(input: ArenaTurnInput): string {
  const history = input.publicKnowledge.actionHistory;
  if (history.length === 0) {
    return 'none';
  }

  return history
    .map((entry) => {
      const play = entry.play ? `${entry.play.type}:${entry.play.primaryValue}:${entry.play.size}` : 'pass';
      return `T${entry.turn} S${entry.seat} ${play} hand=${entry.handCountAfter}`;
    })
    .join('\n');
}

function formatLegalActionSummary(action: ReturnType<typeof serializePromptAction>): string {
  if (action.kind === 'pass') {
    return `- ${action.actionId} | pass`;
  }

  return [
    `- ${action.actionId}`,
    `type=${action.playType}`,
    `size=${action.size}`,
    `primary=${action.primaryValue}`,
    `bomb=${action.bombSize ?? '-'}`,
    `wild=${action.wildCount}`,
    `cards=${action.cards.join(' ')}`,
  ].join(' | ');
}

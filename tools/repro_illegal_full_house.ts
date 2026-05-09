// Repro: confirm full-house comparison rules + check that getLegalActionsForSeat
// never returns a lower full-house when the table holds a higher one. Run with:
//   npx esbuild tools/repro_illegal_full_house.ts --bundle --platform=node --format=cjs --outfile=/tmp/repro_illegal.cjs && node /tmp/repro_illegal.cjs
import { generateAllPlays, filterLegalPlays } from '../src/game/rules';
import { applyPlay, createNewGame } from '../src/game/state';
import { getLegalActionsForSeat } from '../src/arena/engine';
import type { Card, GameState, Seat, Suit, Rank, Play } from '../src/game/types';

let cardId = 1;
function makeCard(suit: Suit, rank: Rank): Card {
  return { id: `c${cardId++}`, suit, rank, deck: 0, isWild: false };
}

function makeFullHouseHand(tripleRank: Rank, pairRank: Rank, extras: Card[]): Card[] {
  // Pad with non-matching singles so playing a 5-card full-house doesn't
  // immediately finish the seat (which short-circuits the currentPlayer
  // advance in applyPlay).
  const filler: Card[] = [
    makeCard('clubs', '7'),
    makeCard('diamonds', '8'),
    makeCard('spades', '5'),
  ];
  return [
    makeCard('clubs', tripleRank),
    makeCard('hearts', tripleRank),
    makeCard('spades', tripleRank),
    makeCard('clubs', pairRank),
    makeCard('hearts', pairRank),
    ...filler,
    ...extras,
  ];
}

const baseState: GameState = createNewGame(() => 0.5);

// Override player hands and currentPlayer/tablePlay deterministically.
const handsBySeat: Record<Seat, Card[]> = {
  0: makeFullHouseHand('4', '2', []),
  1: makeFullHouseHand('9', '4', []),
  2: makeFullHouseHand('J', '3', []),
  3: makeFullHouseHand('6', '2', []),
};

const stateAfterDeal: GameState = {
  ...baseState,
  players: baseState.players.map((player) => ({
    ...player,
    hand: handsBySeat[player.seat],
    finished: false,
  })),
  currentPlayer: 0,
  tablePlay: null,
  passedPlayers: [],
};

function pickFullHouse(hand: Card[], tripleRank: Rank, pairRank: Rank): Play {
  const allPlays: Play[] = generateAllPlays(hand);
  const match = allPlays.find(
    (play) => play.type === 'full-house' && play.label.includes(tripleRank),
  );
  if (!match) {
    throw new Error(`No full-house with triple ${tripleRank} found in hand. Plays: ${allPlays.map((p) => p.label).join(', ')}`);
  }
  return match;
}

const fh4 = pickFullHouse(handsBySeat[0], '4', '2');
const fh9 = pickFullHouse(handsBySeat[1], '9', '4');
const fhJ = pickFullHouse(handsBySeat[2], 'J', '3');
const fh6 = pickFullHouse(handsBySeat[3], '6', '2');

let state = applyPlay(stateAfterDeal, 0, fh4);
state = applyPlay(state, 1, fh9);
state = applyPlay(state, 2, fhJ);

console.log('After teammate (seat 2) plays JJJ33:');
console.log('  state.tablePlay =', state.tablePlay?.play.label, 'owner =', state.tablePlay?.owner);
console.log('  state.currentPlayer =', state.currentPlayer);

const legalForSeat3 = getLegalActionsForSeat(state, 3);
console.log('\nLegal actions for seat 3 (left AI):');
for (const action of legalForSeat3) {
  console.log('  ', action.actionId, action.label ?? '');
}

const fh6Action = legalForSeat3.find((a) => a.kind === 'play' && a.actionId === `play:${fh6.key}`);
console.log('\nIs 66622 (full-house 6) listed as legal?', fh6Action ? 'YES (BUG)' : 'no (correct)');

console.log('\nfilterLegalPlays direct check:');
const allSeat3Plays = generateAllPlays(handsBySeat[3]);
const legalPlays = filterLegalPlays(allSeat3Plays, state.tablePlay?.play ?? null);
console.log('  legal play labels:', legalPlays.map((p) => p.label));

console.log('\nDefensive applyPlay should now reject 66622 after JJJ33:');
try {
  applyPlay(state, 3, fh6);
  console.log('  ❌ applyPlay accepted the illegal play (BUG STILL PRESENT)');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log('  ✅ applyPlay threw as expected:');
  console.log('     ', message);
}

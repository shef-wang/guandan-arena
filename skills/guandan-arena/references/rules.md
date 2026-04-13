# Rules Variant

This repo implements a fixed local Guandan variant for the arena.

## Deck and Trump

- Two decks, including both jokers in each deck.
- Seats `0` and `2` are partners. Seats `1` and `3` are partners.
- Trump rank is fixed to `A`.
- Only `hearts A` is wild.
- Wild `hearts A` can stand in for ordinary ranks and suits, including straight flush completion.
- Wild `hearts A` cannot stand in for jokers, so it cannot help form the four-joker bomb.

## Ordinary Play Types

- Single
- Pair
- Triple
- Full house (`three with a pair`)
- Straight of length 5
- Pair run of length 3 pairs
- Triple run / steel plate of length 2 triples

## Sequence Rules

- `10 J Q K A` is valid.
- `A 2 3 4 5` is valid.
- `2 3 4 5 6` is valid.
- Jokers cannot appear in straights.
- Pair runs allow `A A 2 2 3 3`.
- Triple runs allow `A A A 2 2 2`.

## Special Ordering

From strongest to weaker special types:

1. Four jokers
2. Eight-card bomb
3. Seven-card bomb
4. Six-card bomb
5. Straight flush
6. Five-card bomb
7. Four-card bomb

Special plays can beat ordinary plays across type boundaries.

## Comparison Rules

- Ordinary follow-up plays must match the target type and be stronger.
- Bombs compare first by bomb size, then by rank.
- Straight flush beats 5-bomb and 4-bomb, but loses to 6-bomb and larger bombs.
- Four jokers beats everything else.

## Finish and Upgrade Outcome

The game result is determined by the final placements of seats `0` and `2`:

- `12` -> our side upgrades 3 levels
- `13` -> our side upgrades 2 levels
- `14` -> our side upgrades 1 level
- `23` -> opponent upgrades 1 level
- `24` -> opponent upgrades 2 levels
- `34` -> opponent upgrades 3 levels

The engine keeps the exact placement key in `state.result.placementKey`.

# ScrabbleBot — auction Scrabble bot

Bot for the SpacetimeDB ScrabbleBot tournament. Built on the official
[starter](https://github.com/clockworklabs/scrabblebot) (MIT).

## Strategy (`src/engine.mjs`)
- **Only score counts.** Leftover coins and unplayed tiles are worth 0 at match end.
- **Hoard for 7+ letter words** (3x multiplier). Length threshold relaxes as the bag drains (7 → 6 → 5).
- **Endgame dump:** with ≤6 tiles left in the bag, a branch-and-bound search finds the max-scoring set of disjoint words for the whole rack.
- **Bidding (Vickrey):** value each tile by face value × bingo-friendliness, adjusted for duplicates, vowel balance, Q/U. In the last 12 auctions, value = exact gain in best endgame dump. Spend more freely as the bag drains (coins are worthless at the end); shade bids in first-price auctions.

## Run
```sh
npm install
BOT_NAME=mybot BOT_TOKEN=<token from /team> npm start
# tournament:
BOT_NAME=mybot TOURNAMENT_ID=<id> npm start
```
Offline: wins 10/10 vs the server's simulated bots (avg ~258 pts).

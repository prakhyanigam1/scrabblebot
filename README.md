# ScrabbleBot — auction Scrabble bot

Bot for the SpacetimeDB ScrabbleBot tournament. Built on the official
[starter](https://github.com/clockworklabs/scrabblebot) (MIT).

Letters are auctioned one at a time; bots bid coins, then spell words from
the letters they own. A word scores its letter values times a length
multiplier (1x up to 3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, **3x at 7+**),
and the score is also paid back as coins.

## Strategy (`src/strategy.ts`)

### Bidding: budget-scaled
- **Base value** of a letter ≈ face value × 2.5 + 2 (its worth inside a long word).
- **Rack shape:** bid up for vowels when the rack is under ~30% vowels, and for
  consonants when it's over 50%; small bonus for S, E, R; penalties for a third
  copy of a letter, Q without U, and a second J/Q/X/Z; ×0.6 once the rack is
  clogged (10+ tiles).
- **Budget scaling:** spending coins never lowers score, so coins are only a
  budget. Before the endgame, every bid is scaled by `balance / 40`: a rich bot
  bids up to win letters, a poor one saves. With 13–25 tiles left in the bag,
  bids get a further ×1.3.
- **Endgame (≤12 tiles in the bag):** a letter is worth exactly what it adds to
  the best word we could play right now. If it adds anything, bid
  `max(2 × gain, 50% of balance)`, since leftover coins are worthless at match
  end; if it adds nothing, don't bid.
- **First-price auctions** (winner pays own bid) shade bids to 60% of value.
  Vickrey auctions bid full value. Bids are always capped at our balance.

### Word play: hold for 7+ letter words
- Hold letters until we can spell a **7+ letter word** for the 3x multiplier.
- Play the best word earlier when: there's a 6+ letter word on an 8+ tile
  rack, the rack is clogged (10+ tiles), or we're low on coins (<12).
- **Endgame dump:** with ≤12 tiles left in the bag, play the best word on every
  rack change until nothing more can be spelled, so no tiles are stranded.
- Word search uses a precomputed letter-count index of the wordlist, sorted by
  score, so the first match is the best word (well under 100 ms, see tests).

### Client (`src/index.ts`)
- Bids once per auction, re-checks for a word on every rack or bag change.
- Word checks are throttled to one per 500 ms per match; a check that lands
  inside the window is rescheduled for when it ends rather than dropped, so
  leftover letters still get played after the bag empties.
- Logs auction results only for matches this bot is in.

## Run
```sh
npm install
BOT_NAME=mybot BOT_TOKEN=<token from /team> npm start   # first run, saves .token-mybot
BOT_NAME=mybot npm start                                 # later runs
BOT_NAME=mybot TOURNAMENT_ID=<id> npm start              # enter a tournament
```
`.token-*` files are gitignored; never commit them.

## Test and simulate
```sh
npm test               # strategy checks, incl. a search-speed test
npx tsx sim/sim.ts     # 40 offline 6-bot games per auction type
```
The simulator's opponents bid letter value + 6–14 coins (capped at balance),
matching prices seen in live matches. Latest run:

| Auction type | Wins | Avg score | Best opponent avg |
|---|---|---|---|
| Vickrey | 38/40 | 65 | 42 |
| First-price | 40/40 | 78 | 36 |

Sim opponents use a simple greedy word rule, so live results will be tougher.

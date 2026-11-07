# ScrabbleBot — auction Scrabble bot

Bot for the SpacetimeDB ScrabbleBot tournament. Built on the official
[starter](https://github.com/clockworklabs/scrabblebot) (MIT).

Letters are auctioned one at a time; bots bid coins, then spell words from
the letters they own. A word scores its letter values times a length
multiplier (1x up to 3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, **3x at 7+**),
and the score is also paid back as coins.

## Strategy (`src/strategy.ts`)

### Bidding: spend the budget
Coins are worth nothing at match end and word rewards are paid back as
coins, so the bot treats coins purely as a budget to spend.
- **Base value** of a letter ≈ face value × 2.5 + 2 (its worth inside a long word).
- **Rack shape:** bid up for vowels when the rack is under ~30% vowels, and for
  consonants when it's over 50%; small bonus for S, E, R; penalties for a third
  copy of a letter, Q without U, and a second J/Q/X/Z; ×0.6 once the rack is
  clogged (10+ tiles).
- **Floor:** always bid at least 12 (≈ the live average price) on vowels and
  R, S, T, N, L. Held letters are options, not waste.
- **Pacing:** if our coins per remaining auction are above 2.5 (the top
  bots' spending rate), we're under-spending, so bids go up 1.5×. With 13–25
  tiles left, a further ×1.3.
- **Endgame (≤12 tiles in the bag):** a letter is worth exactly what it adds to
  the best word we could play right now. If it adds anything, bid
  `max(2 × gain, 50% of balance)`, and the whole balance in the last 3
  auctions; if it adds nothing, don't bid.
- **No shading:** in a Vickrey auction (live matches) the winner pays the
  second-highest bid, so bidding true value is optimal. Bids are always
  capped at our balance.

### Word play: hold for 7+ letter words
- Hold letters until we can spell a **7+ letter word** for the 3x multiplier.
- Play the best word earlier only when the rack is clogged (10+ tiles). No
  early plays for low coins or 6-letter words: 7+ letter words earn ~80% of
  the top bots' points, and short words spend the letters they need.
- **Endgame dump:** with ≤12 tiles left in the bag, play the best word on every
  rack change until nothing more can be spelled, so no tiles are stranded.
- Word search uses a precomputed letter-count index of the wordlist, sorted by
  score, so the first match is the best word (well under 100 ms, see tests).

### Client (`src/index.ts`)
- Subscribes only to its own data (its credential, then its matches, their
  auctions and results, its rack and its lobbies). Subscribing to all tables
  streams every match on the server: ~70 s to load and a permanent backlog
  that silently lost the bot's lobby joins.
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
npx tsx sim/sim.ts [games] [vickrey|first|both]
```
The simulator plays `src/strategy.ts` against five opponents calibrated to
the live top bots (LUCENT, Bron), and compares it on the same seeds with the
baseline in `sim/strategy.before.ts`. It reports score, letters won, price
paid, words, word length, reward per word, tiles held and coins left.

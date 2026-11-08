# ScrabbleBot — auction Scrabble bot

Bot for the SpacetimeDB ScrabbleBot tournament. Built on the official
[starter](https://github.com/clockworklabs/scrabblebot) (MIT).

Letters are auctioned one at a time; bots bid coins, then spell words from
the letters they own. A word scores its letter values times a length
multiplier (1x up to 3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, **3x at 7+**),
and the score is also paid back as coins.

## Strategy (`src/strategy.ts`)

### Bidding: buy high-value letters
Coins are worth nothing at match end and word rewards are paid back as
coins, so coins are only a budget. The top bots' edge is *which* letters
they buy: their 7-letter words are built from heavier letters (live, ~40-50
points vs our ~30), so the budget goes to letters that are worth points and
fit a long word.
- **3–5 point letters** (B C M P F H V W Y K): bid 17–20 when the letter keeps
  7–8 letter words within one tile (more the more words it keeps in reach),
  and 20 if it completes a 7+ letter word outright.
- **8–10 point letters** (J Q X Z): same check, bid 22–30.
- **1-point letters** (vowels, R S T N L): a market-rate floor of 12 only when
  the rack needs them (vowels below 35% of the rack, R/S/T/N/L above 50%
  vowels, or a rack under 5 tiles). Otherwise they get the letter-value
  estimate (face × 2.5 + 2, adjusted for rack balance and duplicates).
- **Pacing:** if our coins per remaining auction are above 2.5 (the top bots'
  spending rate), bids go up 1.5×; with 13–25 tiles left, a further ×1.3.
- **Endgame (≤12 tiles in the bag):** a letter is worth exactly what it adds
  to the best word we could play right now: `max(2 × gain, 50% of balance)`,
  the whole balance in the last 3 auctions, nothing if it adds nothing.
- **No shading:** live matches are Vickrey (the winner pays the second-highest
  bid), so bidding true value is optimal. Bids are capped at our balance.
- The 7+ letter check scans ~144k long words once per bid (letters stored
  sparsely): ~10 ms worst case, well inside an auction.

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
baseline in `sim/strategy.before.ts` (the current live version, which a new
candidate has to beat). It reports
score, letters won, price paid, words, word length, reward per word, tiles
held and coins left. Live matches are Vickrey, so test with
`npx tsx sim/sim.ts 30 vickrey`.

Value-weighted bidding vs the previous version, 30 Vickrey games, same seeds:

| | Previous | Value-weighted |
|---|---|---|
| Score | 60.6 | 71.0 |
| Average place (of 6) | 4.10 | 3.37 |
| Reward per word | 17.7 | 22.7 |
| Win rate | 13.3% | 13.3% |

// Edit this file to implement your bidding and word-forming strategy.

// Standard Scrabble letter values — useful for valuation.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// ---- Tunable knobs -------------------------------------------------------

// Hold letters until we can spell a word this long (7 = the 3x bonus).
const TARGET_LEN = 7;
// Play our best word anyway once the rack gets this crowded.
const CLOG_RACK = 10;
// Below this many tiles left in the bag, dump everything we can.
const ENDGAME_BAG = 12;
// Play a word to refill coins when we drop under this balance.
const LOW_BALANCE = 12;
// In first-price auctions we pay our own bid, so bid this fraction of value.
const FIRST_PRICE_SHADE = 0.6;

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

// ---- Word scoring (same math as the server) -----------------------------

// Length multiplier: 1x for <=3, 1.5x at 4, 2x at 5, 2.5x at 6, 3x at 7+.
function lengthMultiplier(len: number): number {
  if (len <= 3) return 1;
  if (len === 4) return 1.5;
  if (len === 5) return 2;
  if (len === 6) return 2.5;
  return 3;
}

export function wordScore(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  return Math.floor(base * lengthMultiplier(word.length));
}

// ---- Fast dictionary index ----------------------------------------------
// Turning each word into a 26-slot letter count once makes "can I spell
// this?" checks much cheaper than rebuilding counts every time.

interface Entry {
  word: string;
  counts: Uint8Array;
  score: number;
}

let indexedFrom: string[] | null = null;
let entries: Entry[] = [];

function buildIndex(dictionary: string[]) {
  if (indexedFrom === dictionary) return;
  entries = [];
  for (const word of dictionary) {
    if (word.length < 2) continue;
    const counts = new Uint8Array(26);
    let ok = true;
    for (const c of word) {
      const i = c.charCodeAt(0) - 65;
      if (i < 0 || i > 25) {
        ok = false;
        break;
      }
      counts[i]++;
    }
    if (ok) entries.push({ word, counts, score: wordScore(word) });
  }
  // Highest score first, so the first hit is the best word.
  entries.sort((a, b) => b.score - a.score);
  indexedFrom = dictionary;
}

function rackCounts(rack: Map<string, number>): Uint8Array {
  const counts = new Uint8Array(26);
  for (const [c, n] of rack) {
    const i = c.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) counts[i] += n;
  }
  return counts;
}

function rackSize(rack: Map<string, number>): number {
  let tiles = 0;
  for (const n of rack.values()) tiles += n;
  return tiles;
}

// Build the index ahead of time so the first live search isn't slow.
export function warmUp(dictionary: string[]) {
  buildIndex(dictionary);
}

// Best-scoring word the rack can spell, or null.
export function bestWord(
  rack: Map<string, number>,
  dictionary: string[],
): Entry | null {
  buildIndex(dictionary);
  const have = rackCounts(rack);
  const tiles = rackSize(rack);
  for (const e of entries) {
    if (e.word.length > tiles) continue;
    let fits = true;
    for (let i = 0; i < 26; i++) {
      if (e.counts[i] > have[i]) {
        fits = false;
        break;
      }
    }
    if (fits) return e;
  }
  return null;
}

// ---- Bidding --------------------------------------------------------------

export interface BidContext {
  letter: string;        // Letter being auctioned, e.g. "Q"
  myBalance: number;     // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
  bagLeft?: number;      // Tiles still in the bag (if known)
  firstPrice?: boolean;  // true = winner pays own bid; false = Vickrey
  dictionary?: string[]; // Shared word list (if available)
}

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 *
 * Idea: estimate how many points this letter will be worth to us.
 * - Early on, a letter is worth roughly its face value times the ~2x
 *   multiplier it'll get inside a long word, nudged by whether our rack
 *   needs vowels or consonants.
 * - Late in the match there's no time to build around it, so it's only
 *   worth what it adds to the best word we could play right now.
 */
export function decideBid(ctx: BidContext): number {
  const L = ctx.letter;
  const face = LETTER_VALUE[L] ?? 1;
  const have = ctx.myRack.get(L) ?? 0;
  const tiles = rackSize(ctx.myRack);
  const bagLeft = ctx.bagLeft ?? 99;

  // How much of the rack is vowels right now.
  let vowels = 0;
  for (const [c, n] of ctx.myRack) if (VOWELS.has(c)) vowels += n;
  const vowelRatio = tiles === 0 ? 0.4 : vowels / tiles;

  // Long-term value: letter points inside a ~2.5x word, plus flexibility.
  let value = face * 2.5 + 2;

  // Balance the rack: words need about 40% vowels.
  if (VOWELS.has(L)) {
    if (vowelRatio < 0.3) value += 5;
    else if (vowelRatio > 0.5) value -= 3;
  } else {
    if (vowelRatio > 0.5) value += 3;
    else if (vowelRatio < 0.25) value -= 3;
  }

  // Common word-builders.
  if (L === "S" || L === "E" || L === "R") value += 2;

  // Too many copies of one letter hurts.
  if (have >= 2) value -= 4 * (have - 1);

  // Q is nearly useless without a U.
  if (L === "Q" && (ctx.myRack.get("U") ?? 0) === 0) value = 4;
  // V and awkward heavies: fine, but don't overpay for doubles.
  if ((L === "J" || L === "Z" || L === "X" || L === "Q") && have >= 1) value = 2;

  // A crowded rack makes each new letter less useful.
  if (tiles >= CLOG_RACK) value *= 0.6;

  // Endgame: only pay for what it adds to a word we can play now.
  if (ctx.dictionary && bagLeft <= ENDGAME_BAG) {
    const before = bestWord(ctx.myRack, ctx.dictionary)?.score ?? 0;
    const withIt = new Map(ctx.myRack);
    withIt.set(L, have + 1);
    const after = bestWord(withIt, ctx.dictionary)?.score ?? 0;
    const gain = Math.max(0, after - before);
    // Coins are worthless once the match ends, so go big for any gain.
    value = gain > 0 ? Math.max(gain * 2, ctx.myBalance * 0.5) : 0;
  } else {
    // Spending coins never lowers score, so coins are only a budget.
    // Scale bids to how much budget we have: rich = bid up, poor = save.
    value *= ctx.myBalance / 40;
  }

  // Coins left at the end are worthless, so loosen up as the bag empties.
  if (bagLeft <= 25 && bagLeft > ENDGAME_BAG) value *= 1.3;

  if (ctx.firstPrice) value *= FIRST_PRICE_SHADE;

  // Never bid more than we can pay: winning without the coins gets nothing.
  const bid = Math.round(value);
  return Math.max(0, Math.min(bid, ctx.myBalance));
}

// ---- Word playing ---------------------------------------------------------

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Sorted uppercase list, shared at startup
  bagLeft?: number;     // Tiles still in the bag (if known)
  myBalance?: number;   // Current balance (if known)
}

/**
 * Try to form a word using letters from `myRack`.
 * Return the word (uppercase) to play, or null to skip.
 *
 * Strategy: hold letters until we can make a 7+ letter word (3x bonus).
 * Play the best word sooner if the rack is clogged, coins are low,
 * or the match is about to end.
 *
 * Keep this fast. The bot runs it on every rack change, and while it runs
 * the bot can't see the match move on: a search that takes longer than an
 * auction means bids on closed auctions and words from spent letters.
 */
export function chooseWord(ctx: WordContext): string | null {
  const best = bestWord(ctx.myRack, ctx.dictionary);
  if (!best) return null;

  const tiles = rackSize(ctx.myRack);
  const bagLeft = ctx.bagLeft ?? 99;
  const balance = ctx.myBalance ?? 100;

  const endgame = bagLeft <= ENDGAME_BAG;
  const bigWord = best.word.length >= TARGET_LEN;
  const clogged = tiles >= CLOG_RACK;
  const broke = balance < LOW_BALANCE;
  // A good 6-letter word on a fairly full rack is worth taking.
  const solidSix = best.word.length >= 6 && tiles >= 8;

  if (endgame || bigWord || clogged || broke || solidSix) return best.word;
  return null;
}

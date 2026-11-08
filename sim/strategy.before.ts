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

// Budget pacing. Top bots spend ~170 coins over ~68 auctions, about 2.5 a
// round. If our coins per remaining round are above that, we're
// under-spending: raise bids by this factor.
const PACE_PER_ROUND = 2.5;
const UNDERSPEND_BOOST = 1.5;
// Bid at least this (≈ the live average winning price) on vowels and
// common 1-point letters, but only when the rack needs them: vowels when
// we're low on vowels, R/S/T/N/L when we're vowel-heavy, either while the
// rack is too small to build on. Otherwise cheap letters soak up coins
// that should buy high-value ones.
const FLOOR_BID = 12;
const FLOOR_LETTERS = new Set(["A", "E", "I", "O", "U", "R", "S", "T", "N", "L"]);
const LOW_VOWELS = 0.35;
const HIGH_VOWELS = 0.5;

// High-value letters are what make the top bots' 7-letter words worth
// 40-50 vs our ~30 (RackMaw wins 3-5 point letters at ~16.5 and J/Q/X/Z at
// ~32). Bid MIN..MAX on one that keeps 7–8 letter words within one tile,
// more the more it keeps in reach, and MAX if it completes a 7+ letter word.
// 3–5 points: B C M P F H V W Y K.
const HIGH_VALUE_MIN = 17;
const HIGH_VALUE_MAX = 20;
// 8–10 points: J Q X Z.
const PREMIUM_MIN = 22;
const PREMIUM_MAX = 30;
// Below this many tiles no 7-letter word can be one tile away from
// rack + letter, so the check can't apply.
const MIN_TARGET_RACK = 5;
// In the last few auctions coins are about to be worthless: bid them all on
// any letter that improves our best word.
const FINAL_ROUNDS = 3;

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
// Words of 7+ letters, best score first, letters stored sparsely
// (index + count) for a fast scan.
interface LongEntry {
  e: Entry;
  len: number;
  idx: Uint8Array;
  cnt: Uint8Array;
}
let longEntries: LongEntry[] = [];

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
  longEntries = [];
  for (const e of entries) {
    if (e.word.length < 7) continue;
    const idx: number[] = [];
    const cnt: number[] = [];
    for (let i = 0; i < 26; i++) {
      if (e.counts[i]) {
        idx.push(i);
        cnt.push(e.counts[i]!);
      }
    }
    longEntries.push({ e, len: e.word.length, idx: Uint8Array.from(idx), cnt: Uint8Array.from(cnt) });
  }
  indexedFrom = dictionary;
}

// What rack + letter `li` offers toward 7+ letter words: whether it spells
// one now, and how many 7–8 letter words it is exactly one tile short of.
function reachWith(
  have: Uint8Array,
  li: number,
  tiles: number,
): { completes: boolean; oneAway: number } {
  let completes = false;
  let oneAway = 0;
  for (const w of longEntries) {
    if (w.len > tiles + 2) continue; // 2+ tiles short even with the letter
    let missing = 0;
    for (let k = 0; k < w.idx.length; k++) {
      const i = w.idx[k]!;
      const d = w.cnt[k]! - have[i]! - (i === li ? 1 : 0);
      if (d > 0 && (missing += d) > 1) break;
    }
    if (missing === 0) completes = true;
    else if (missing === 1 && w.len <= 8) oneAway++;
  }
  return { completes, oneAway };
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

  // Auctions left including this one (bagLeft is the bag after drawing it).
  const roundsLeft = bagLeft + 1;

  // Endgame: only pay for what it adds to a word we can play now.
  if (ctx.dictionary && bagLeft <= ENDGAME_BAG) {
    const before = bestWord(ctx.myRack, ctx.dictionary)?.score ?? 0;
    const withIt = new Map(ctx.myRack);
    withIt.set(L, have + 1);
    const after = bestWord(withIt, ctx.dictionary)?.score ?? 0;
    const gain = Math.max(0, after - before);
    // Coins are worthless once the match ends, so go big for any gain,
    // and in the last few rounds bid everything.
    if (gain <= 0) value = 0;
    else if (roundsLeft <= FINAL_ROUNDS) value = ctx.myBalance;
    else value = Math.max(gain * 2, ctx.myBalance * 0.5);
  } else {
    // Cheap common letters: a market-rate bid only when the rack needs them.
    if (FLOOR_LETTERS.has(L)) {
      const needed =
        tiles < MIN_TARGET_RACK ||
        (VOWELS.has(L) ? vowelRatio < LOW_VOWELS : vowelRatio > HIGH_VOWELS);
      if (needed) value = Math.max(value, FLOOR_BID);
    }
    // High-value letters that keep 7–8 letter words in reach: bid up.
    if (ctx.dictionary && face >= 3 && tiles >= MIN_TARGET_RACK) {
      const [lo, hi] = face >= 8 ? [PREMIUM_MIN, PREMIUM_MAX] : [HIGH_VALUE_MIN, HIGH_VALUE_MAX];
      buildIndex(ctx.dictionary);
      const { completes, oneAway } = reachWith(rackCounts(ctx.myRack), L.charCodeAt(0) - 65, tiles);
      if (completes) {
        value = Math.max(value, hi);
      } else if (oneAway > 0) {
        // 1 word in reach -> lo, 31+ words -> hi.
        const t = Math.min(1, Math.log2(1 + oneAway) / 5);
        value = Math.max(value, lo + (hi - lo) * t);
      }
    }
    // Pace spending evenly over the match. myBalance already includes what
    // our words earned, so new coins go straight back into bidding.
    const coinsPerRoundTarget = ctx.myBalance / roundsLeft;
    if (coinsPerRoundTarget > PACE_PER_ROUND) value *= UNDERSPEND_BOOST;
    // Coins left at the end are worthless, so loosen up as the bag empties.
    if (bagLeft <= 25) value *= 1.3;
  }

  // No shading: in a Vickrey auction we pay the second-highest bid, so
  // bidding true value is optimal.

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
 * Play the best word sooner if the rack is clogged
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

  const endgame = bagLeft <= ENDGAME_BAG;
  const bigWord = best.word.length >= TARGET_LEN;
  const clogged = tiles >= CLOG_RACK;
  // No early plays for low coins or 6-letter words: 7+ letter words earn
  // most of the points, and short words spend the letters they need.

  if (endgame || bigWord || clogged) return best.word;
  return null;
}

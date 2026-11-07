// Strategy engine — plain JS (no deps) so it can be tested with bare `node`.
//
// Key facts from the server code (spacetimedb/src/game.ts):
//  * Only `score` ranks. Leftover coins and unplayed tiles are worth NOTHING
//    at match end, so: spend money, and dump the rack before the bag empties.
//  * Word reward = sum(face) * mult(len): 1x <=3, 1.5x 4, 2x 5, 2.5x 6, 3x 7+.
//  * Bids can be re-submitted (replaced). Vickrey by default (pay 2nd price).
//  * If the winner can't afford `paid`, the tile is lost — never bid > balance.
import * as fs from "node:fs";

export const LV = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1,
  M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8,
  Y: 4, Z: 10,
};
const LVA = new Int32Array(26);
for (const [k, v] of Object.entries(LV)) LVA[k.charCodeAt(0) - 65] = v;

export const BAG = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};
const VOWELS = new Set(["A", "E", "I", "O", "U"]);

export function mult(len) {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}
export function wordScore(w) {
  let base = 0;
  for (let i = 0; i < w.length; i++) base += LVA[w.charCodeAt(i) - 65];
  const [n, d] = mult(w.length);
  return Math.floor((base * n) / d);
}

// ---------- Dictionary ----------
// words[i], codes (flat Uint8Array of letter indices), offs, scores.
export function loadDictionary(path) {
  const raw = fs.readFileSync(path, "utf8").split("\n");
  const words = [];
  for (const l of raw) {
    const w = l.trim().toUpperCase();
    if (w.length >= 2 && /^[A-Z]+$/.test(w)) words.push(w);
  }
  const n = words.length;
  let total = 0;
  for (const w of words) total += w.length;
  const codes = new Uint8Array(total);
  const offs = new Uint32Array(n + 1);
  const scores = new Int32Array(n);
  let p = 0;
  for (let i = 0; i < n; i++) {
    offs[i] = p;
    const w = words[i];
    for (let j = 0; j < w.length; j++) codes[p++] = w.charCodeAt(j) - 65;
    scores[i] = wordScore(w);
  }
  offs[n] = p;
  return { words, codes, offs, scores, n };
}

export function rackToCounts(rack /* Map<string,number> */) {
  const c = new Int32Array(26);
  for (const [k, v] of rack) {
    const i = k.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) c[i] += v;
  }
  return c;
}
function total(c) {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i];
  return t;
}

const tmp = new Int32Array(26);
// All dictionary indices spellable from `counts`.
export function candidates(dict, counts, pool = null) {
  const { codes, offs } = dict;
  const tiles = total(counts);
  const out = [];
  const iter = pool ?? null;
  const N = iter ? iter.length : dict.n;
  for (let k = 0; k < N; k++) {
    const i = iter ? iter[k] : k;
    const s = offs[i], e = offs[i + 1];
    if (e - s > tiles) continue;
    tmp.set(counts);
    let ok = true;
    for (let p = s; p < e; p++) {
      if (--tmp[codes[p]] < 0) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function fits(dict, i, counts) {
  const { codes, offs } = dict;
  tmp.set(counts);
  for (let p = offs[i]; p < offs[i + 1]; p++) if (--tmp[codes[p]] < 0) return false;
  return true;
}
function sub(dict, i, counts) {
  const c = new Int32Array(counts);
  for (let p = dict.offs[i]; p < dict.offs[i + 1]; p++) c[dict.codes[p]]--;
  return c;
}

// Best set of disjoint words (max total score) from `counts`.
// Branch-and-bound DFS over candidates sorted by score, node-limited.
export function bestPlan(dict, counts, cands = null, nodeLimit = 40000) {
  let cs = cands ?? candidates(dict, counts);
  cs = cs.slice().sort((a, b) => dict.scores[b] - dict.scores[a]);
  // Upper bound on remaining: all remaining tiles at 3x face value.
  const ub = (c) => {
    let s = 0;
    for (let i = 0; i < 26; i++) s += c[i] * LVA[i];
    return s * 3;
  };
  let best = { score: 0, words: [] };
  let nodes = 0;
  const path = [];
  const dfs = (c, start, acc) => {
    if (acc > best.score) best = { score: acc, words: path.map((i) => dict.words[i]) };
    if (++nodes > nodeLimit) return;
    if (acc + ub(c) <= best.score) return;
    for (let k = start; k < cs.length; k++) {
      const i = cs[k];
      if (!fits(dict, i, c)) continue;
      path.push(i);
      dfs(sub(dict, i, c), k, acc + dict.scores[i]);
      path.pop();
      if (nodes > nodeLimit) return;
    }
  };
  dfs(counts, 0, 0);
  return best;
}

// ---------- Word choice ----------
// Returns a word to play now, or null to keep hoarding.
//   bagLeft: tiles still in the bag (matchState.bagTotal)
export function chooseWordAdvanced(dict, rack, bagLeft) {
  const counts = rackToCounts(rack);
  const tiles = total(counts);
  if (tiles < 2) return null;
  const cands = candidates(dict, counts);
  if (cands.length === 0) return null;

  // Endgame: dump the whole rack optimally. The match ends the instant the
  // last tile's auction closes, so start early enough.
  if (bagLeft <= ENDGAME_TILES) {
    const plan = bestPlan(dict, counts, cands);
    return plan.words.length ? plan.words[0] : null;
  }

  // Minimum length worth cashing grows looser as the game runs out.
  const minLen = bagLeft > 30 ? 7 : bagLeft > 18 ? 6 : 5;
  let bestI = -1, bestVal = -1;
  for (const i of cands) {
    const len = dict.offs[i + 1] - dict.offs[i];
    if (len < minLen) continue;
    // Prefer high score; small penalty for a poor leftover (vowel balance).
    const left = sub(dict, i, counts);
    const val = dict.scores[i] + leaveQuality(left) * 0.5;
    if (val > bestVal) { bestVal = val; bestI = i; }
  }
  if (bestI >= 0) return dict.words[bestI];

  // Rack getting clogged with a high-value tile we can cash big now (e.g. Q/Z/X/J
  // in a 5-6 letter word) once mid-game.
  if (bagLeft <= 45) {
    for (const i of cands) {
      const len = dict.offs[i + 1] - dict.offs[i];
      if (len >= 5 && dict.scores[i] >= 40) return dict.words[i];
    }
  }
  return null;
}
export const ENDGAME_TILES = 6;

// Heuristic quality of a leave (rack after playing) — higher is better.
function leaveQuality(c) {
  let v = 0, n = 0, pen = 0;
  for (let i = 0; i < 26; i++) {
    n += c[i];
    const ch = String.fromCharCode(65 + i);
    if (VOWELS.has(ch)) v += c[i];
    if (c[i] > 2) pen += (c[i] - 2) * 2;
  }
  if (n === 0) return 0;
  const frac = v / n;
  pen += Math.abs(frac - 0.42) * 10;
  if (c[16] > 0 && c[20] === 0) pen += 4; // Q without U
  return -pen;
}

// ---------- Bidding ----------
// How useful a letter is for building long words, ~1.0 average.
const FRIENDLY = {
  E: 1.35, S: 1.4, A: 1.2, I: 1.15, R: 1.25, N: 1.2, T: 1.2, O: 1.05, L: 1.1,
  D: 1.1, U: 0.85, G: 1.0, C: 1.0, M: 1.0, P: 1.0, H: 1.0, B: 0.9, Y: 0.9,
  F: 0.85, K: 0.8, W: 0.8, V: 0.7, X: 0.75, Z: 0.7, J: 0.55, Q: 0.4,
};

// Rough points a tile adds to our final score if acquired now (midgame).
export function letterValue(letter, rack) {
  const counts = rackToCounts(rack);
  const n = total(counts);
  const i = letter.charCodeAt(0) - 65;
  const have = counts[i];
  const face = LV[letter] ?? 1;
  let f = FRIENDLY[letter] ?? 1;

  // Duplicates lose value fast (except E/S/A/I which tolerate 2-3).
  const tol = "EAI".includes(letter) ? 2 : letter === "S" ? 2 : 1;
  if (have >= tol) f *= Math.pow(0.55, have - tol + 1);

  // Vowel/consonant balance.
  let v = 0;
  for (const ch of VOWELS) v += counts[ch.charCodeAt(0) - 65];
  const frac = n ? v / n : 0.4;
  const isV = VOWELS.has(letter);
  if (isV && frac > 0.5) f *= 0.55;
  if (isV && frac < 0.3) f *= 1.3;
  if (!isV && frac < 0.25) f *= 0.6;
  if (!isV && frac > 0.55) f *= 1.25;

  // Q wants U; U is extra good if we hold Q.
  if (letter === "Q" && counts[20] === 0) f *= 0.6;
  if (letter === "U" && counts[16] > 0 && have === 0) f *= 1.8;

  // Each tile played in a 7+ word earns 3x face; plus it enables length.
  return f * (face * 2.4 + 3.5);
}

// Exact-ish endgame value: improvement in best dump score.
export function marginalDumpValue(dict, rack, letter) {
  const c0 = rackToCounts(rack);
  const c1 = new Int32Array(c0);
  c1[letter.charCodeAt(0) - 65]++;
  const cands1 = candidates(dict, c1);
  const cands0 = candidates(dict, c0, cands1);
  const a = bestPlan(dict, c0, cands0, 15000).score;
  const b = bestPlan(dict, c1, cands1, 15000).score;
  return b - a;
}

/**
 * ctx: { letter, myBalance, myRack, bagLeft, firstPrice, players }
 */
export function decideBidAdvanced(dict, ctx) {
  const { letter, myBalance, myRack, bagLeft, firstPrice } = ctx;
  if (myBalance <= 0) return 0;
  // Auctions left including this one (bagLeft excludes the tile on offer).
  const left = bagLeft + 1;

  let value;
  if (left <= 12) {
    // Late: what this tile actually adds to our final dump, plus a little
    // option value for future tiles while there's still time.
    const m = marginalDumpValue(dict, myRack, letter);
    const opt = left > 4 ? letterValue(letter, myRack) * (left / 30) : 0;
    value = m + opt;
  } else {
    value = letterValue(letter, myRack);
  }

  // Coins are worthless at the end: spend more freely as the bag drains,
  // and when we're cash-rich relative to remaining auctions.
  const progress = 1 - Math.min(1, left / 98);
  let k = 0.9 + 0.6 * progress;
  const perAuction = myBalance / Math.max(1, left);
  if (perAuction > 8) k *= 1.25;
  if (perAuction < 2.5) k *= 0.75;

  let bid = value * k;
  if (firstPrice) bid *= 0.65; // shade in first-price auctions
  bid = Math.round(bid);

  // Reserve: keep a little cash for later tiles unless it's the very end.
  const reserve = left <= 3 ? 0 : Math.min(myBalance * 0.35, left * 1.5);
  bid = Math.min(bid, Math.floor(myBalance - reserve));
  if (left <= 3 && value > 0) bid = Math.max(bid, Math.min(myBalance, Math.round(value * 1.5)));
  return Math.max(0, Math.min(bid, myBalance));
}

// Offline match simulator for tuning src/strategy.ts.
//
//   npx tsx sim/sim.ts [games] [vickrey|first|both]
//
// Plays your strategy (seat 0) against five opponents modelled on the real
// top bots (LUCENT, Bron), and compares it to the baseline in
// sim/strategy.before.ts on the same seeds. Rules follow the server
// (spacetimedb/src/game.ts): 98-tile bag, 5 tiles dealt, 100 coins, unsold
// letters are discarded, and the match ends the moment the last auction
// closes, so the last letter can't be played.
import * as fs from "node:fs";
import * as after from "../src/strategy.js";
import * as before from "./strategy.before.js";

type Rack = Map<string, number>;
type Strat = Pick<typeof after, "decideBid" | "chooseWord" | "warmUp">;

const dictURL = ["../wordlist.txt", "../../spacetimedb/wordlist.txt"]
  .map((p) => new URL(p, import.meta.url))
  .find((u) => fs.existsSync(u))!;
const dict = fs
  .readFileSync(dictURL, "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2)
  .sort((a, b) => b.length - a.length);
before.warmUp(dict);
after.warmUp(dict);

const BAG: [string, number][] = [["A",9],["B",2],["C",2],["D",4],["E",12],["F",2],["G",3],["H",2],["I",9],["J",1],["K",1],["L",4],["M",2],["N",6],["O",8],["P",2],["Q",1],["R",6],["S",4],["T",6],["U",4],["V",2],["W",2],["X",1],["Y",2],["Z",1]];
const LV = before.LETTER_VALUE;
const VOWELS = new Set(["A", "E", "I", "O", "U"]);

// Seeded RNG so both strategies face the same bags and opponent noise.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const size = (r: Rack) => { let t = 0; for (const n of r.values()) t += n; return t; };

// ---- Opponent model ------------------------------------------------------
// Calibrated so the sim's market matches live matches 42700+ (Nov 2026):
// price paid p50 11 / p90 18, winning bid p50 14 / p90 25; top bots win
// ~14 letters at ~12 each, play ~3.2 words averaging ~5.7 letters (most of
// them 7+), dump short words in the last ~10% of the match, hold <1 tile
// at the end and finish with ~25-30 coins.
const OPP = { base: 9.5, perPoint: 2.3, sigma: 0.28, dupPenalty: 3, dumpAuctions: 7, clog: 12, longWord: 7 };

interface Player { strat: Strat | null; rack: Rack; bal: number; score: number; won: number; paid: number; words: number; letters: number; skill: number }

function oppBid(p: Player, L: string, r: () => number): number {
  const have = p.rack.get(L) ?? 0;
  let v = OPP.base + OPP.perPoint * (LV[L] ?? 1);
  if (have >= 1) v -= OPP.dupPenalty * have;
  if (L === "Q" && !(p.rack.get("U") ?? 0)) v *= 0.6;
  let vowels = 0;
  for (const [c, n] of p.rack) if (VOWELS.has(c)) vowels += n;
  const ratio = size(p.rack) ? vowels / size(p.rack) : 0.4;
  if (VOWELS.has(L) ? ratio > 0.5 : ratio < 0.25) v -= 3;
  if (size(p.rack) >= OPP.clog) v *= 0.7;
  v *= p.skill * Math.exp(OPP.sigma * gauss(r));
  return Math.max(0, Math.min(Math.round(v), p.bal));
}

function oppWord(p: Player, auctionsLeft: number): string | null {
  const best = before.bestWord(p.rack, dict);
  if (!best) return null;
  if (best.word.length >= OPP.longWord || auctionsLeft <= OPP.dumpAuctions || size(p.rack) >= OPP.clog) return best.word;
  return null;
}

// ---- One match -------------------------------------------------------------

interface Market { paid: number[]; top: number[] }

function game(me: Strat, seed: number, firstPrice: boolean, market: Market) {
  const r = rng(seed);
  const bag: string[] = [];
  for (const [l, n] of BAG) for (let i = 0; i < n; i++) bag.push(l);
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [bag[i], bag[j]] = [bag[j]!, bag[i]!]; }
  const P: Player[] = [...Array(6)].map((_, i) => ({
    strat: i === 0 ? me : null, rack: new Map(), bal: 100, score: 0, won: 0, paid: 0, words: 0, letters: 0,
    skill: i === 0 ? 1 : 0.85 + 0.3 * r(),
  }));
  for (const p of P) for (let k = 0; k < 5; k++) { const l = bag.pop()!; p.rack.set(l, (p.rack.get(l) ?? 0) + 1); }

  const play = (p: Player) => {
    for (let g = 0; g < 6; g++) {
      const auctionsLeft = bag.length + 1;
      const w = p.strat
        ? p.strat.chooseWord({ myRack: p.rack, dictionary: dict, bagLeft: bag.length, myBalance: p.bal })
        : oppWord(p, auctionsLeft);
      if (!w) return;
      for (const c of w) p.rack.set(c, p.rack.get(c)! - 1);
      const s = before.wordScore(w);
      p.bal += s; p.score += s; p.words++; p.letters += w.length;
    }
  };
  for (const p of P) play(p);

  while (bag.length) {
    const L = bag.pop()!;
    // Server's bagTotal after drawing this auction's letter.
    const bids = P.map((p) =>
      p.strat
        ? p.strat.decideBid({ letter: L, myBalance: p.bal, myRack: p.rack, bagLeft: bag.length, firstPrice, dictionary: dict })
        : oppBid(p, L, r),
    );
    const order = bids.map((b, i) => ({ b, i, t: r() })).filter((x) => x.b > 0).sort((a, b) => b.b - a.b || a.t - b.t);
    if (order.length) {
      const w = order[0]!;
      const paid = firstPrice ? w.b : order[1]?.b ?? Math.min(1, w.b);
      market.top.push(w.b);
      market.paid.push(paid);
      const p = P[w.i]!;
      if (p.bal >= paid) { p.bal -= paid; p.paid += paid; p.won++; p.rack.set(L, (p.rack.get(L) ?? 0) + 1); }
    }
    if (!bag.length) break; // match ends as the last auction closes
    for (const p of P) play(p);
  }
  const ranked = [...P].sort((a, b) => b.score - a.score);
  return { P, place: ranked.indexOf(P[0]!) + 1 };
}

// ---- Report ----------------------------------------------------------------

function run(label: string, s: Strat, games: number, firstPrice: boolean) {
  const market: Market = { paid: [], top: [] };
  const acc = { wins: 0, place: 0, score: 0, won: 0, paid: 0, words: 0, letters: 0, held: 0, bal: 0 };
  const opp = { score: 0, won: 0, paid: 0, words: 0, letters: 0, held: 0, bal: 0, n: 0 };
  for (let g = 0; g < games; g++) {
    const { P, place } = game(s, 1000 + g, firstPrice, market);
    const me = P[0]!;
    acc.wins += place === 1 ? 1 : 0; acc.place += place; acc.score += me.score; acc.won += me.won; acc.paid += me.paid;
    acc.words += me.words; acc.letters += me.letters; acc.held += size(me.rack); acc.bal += me.bal;
    for (const o of P.slice(1)) { opp.n++; opp.score += o.score; opp.won += o.won; opp.paid += o.paid; opp.words += o.words; opp.letters += o.letters; opp.held += size(o.rack); opp.bal += o.bal; }
  }
  const f = (x: number, d = 2) => x.toFixed(d);
  const row = (name: string, a: typeof opp, n: number, extra = "") =>
    console.log(
      name.padEnd(16), extra.padEnd(22), f(a.score / n, 1).padStart(7), f(a.won / n).padStart(7), f(a.paid / (a.won || 1)).padStart(8),
      f(a.words / n).padStart(7), f(a.letters / (a.words || 1)).padStart(7), f(a.score / (a.words || 1), 1).padStart(8), f(a.held / n).padStart(6), f(a.bal / n, 1).padStart(6),
    );
  row(label, { ...acc, n: games }, games, `win ${f((100 * acc.wins) / games, 1)}% place ${f(acc.place / games)}`);
  return { market, opp };
}

const GAMES = Number(process.argv[2] ?? 200);
const MODE = process.argv[3] ?? "vickrey";
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
for (const fp of MODE === "both" ? [false, true] : [MODE === "first"]) {
  console.log(`\n=== ${fp ? "first-price" : "vickrey"}, ${GAMES} games, 5 top-bot-like opponents ===`);
  console.log("strategy         result                   score/m  won/m  paid/let words/m  avgLen rew/word  held  coins");
  run("before", before, GAMES, fp);
  const { market, opp } = run("after", after, GAMES, fp);
  const n = opp.n;
  const f = (x: number, d = 2) => x.toFixed(d);
  console.log(
    "opponents (avg)".padEnd(16), "".padEnd(22), f(opp.score / n, 1).padStart(7), f(opp.won / n).padStart(7), f(opp.paid / opp.won).padStart(8),
    f(opp.words / n).padStart(7), f(opp.letters / opp.words).padStart(7), f(opp.score / opp.words, 1).padStart(8), f(opp.held / n).padStart(6), f(opp.bal / n, 1).padStart(6),
  );
  console.log("live top bots    LUCENT/Bron, last 50       ~95   13-14    ~12.4  3.0-3.3 5.6-5.8   29-31  0.6-0.8  23-33");
  console.log(`market: paid p50 ${q(market.paid, 0.5)} p90 ${q(market.paid, 0.9)} | winning bid p50 ${q(market.top, 0.5)} p90 ${q(market.top, 0.9)}   (live: paid 11/18, bid 14/25)`);
}

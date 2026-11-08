// Checks for the default strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid, warmUp } from "./strategy.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

test("chooseWord holds short words mid-game and dumps them in the endgame", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary, bagLeft: 60 }), null);
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary, bagLeft: 5 }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CATX"), dictionary, bagLeft: 5 }), "CAT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary, bagLeft: 5 }), null);
});

// The bot can't see a match move on while it searches, so a slow search
// means bids on closed auctions and words from letters it already spent.
const loadWordlist = () =>
  fs
    .readFileSync(
      // Standalone repo: ../wordlist.txt. Monorepo: ../../spacetimedb/.
      ["../wordlist.txt", "../../spacetimedb/wordlist.txt"]
        .map((p) => new URL(p, import.meta.url))
        .find((u) => fs.existsSync(u))!,
      "utf8",
    )
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2)
    .sort((a, b) => b.length - a.length);

test("chooseWord searches the whole wordlist well within an auction", () => {
  const dictionary = loadWordlist();
  // The largest rack an admin can set, with almost nothing to spell.
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  warmUp(dictionary);
  const start = performance.now();
  chooseWord({ myRack, dictionary });
  assert.ok(performance.now() - start < 100, "a search took 100 ms or more");
});

// Value-weighted bidding scans the 7+ letter words for high-value letters,
// so it must also fit well within an auction.
test("decideBid stays under 100 ms per decision", () => {
  const dictionary = loadWordlist();
  warmUp(dictionary);
  for (const r of ["AEIRST", "AEEINRSTL", "AEIOURSTLNDG", "BCDFGHJKLMNPQRSTVWXZ"]) {
    for (const letter of ["E", "S", "B", "K", "Q", "Z"]) {
      const start = performance.now();
      const bid = decideBid({ letter, myBalance: 100, myRack: rack(r), bagLeft: 60, dictionary });
      const ms = performance.now() - start;
      assert.ok(ms < 100, `bid on ${letter} with ${r} took ${ms.toFixed(1)} ms`);
      assert.ok(bid >= 0 && bid <= 100);
    }
  }
});

test("decideBid buys high-value letters that fit and skips cheap ones the rack doesn't need", () => {
  const dictionary = loadWordlist();
  warmUp(dictionary);
  const bid = (letter: string, r: string) =>
    decideBid({ letter, myBalance: 100, myRack: rack(r), bagLeft: 60, dictionary });
  // 3–5 point letters that keep 7-letter words in reach: 17–20.
  assert.ok(bid("B", "AEIRST") >= 17 && bid("B", "AEIRST") <= 20, `B bid ${bid("B", "AEIRST")}`);
  // J/Q/X/Z in reach: up to 30.
  assert.ok(bid("Z", "AEIRST") >= 22 && bid("Z", "AEIRST") <= 30, `Z bid ${bid("Z", "AEIRST")}`);
  // A balanced rack doesn't need another 1-point vowel: well under the 12 floor.
  assert.ok(bid("A", "AEIRST") < 12, `A bid ${bid("A", "AEIRST")}`);
  // A vowel-heavy rack does need R/S/T/N/L: floor of 12.
  assert.ok(bid("R", "EEEEAAAIIIOOORRSSTTNNLL") >= 12);
});

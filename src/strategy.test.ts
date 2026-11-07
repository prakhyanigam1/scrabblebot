// Checks for the default strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, warmUp } from "./strategy.js";

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
test("chooseWord searches the whole wordlist well within an auction", () => {
  const dictionary = fs
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
  // The largest rack an admin can set, with almost nothing to spell.
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  warmUp(dictionary);
  const start = performance.now();
  chooseWord({ myRack, dictionary });
  assert.ok(performance.now() - start < 100, "a search took 100 ms or more");
});

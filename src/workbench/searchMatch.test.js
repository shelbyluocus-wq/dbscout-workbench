import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSearchMatches,
  highlightSearchText,
  matchSearchText,
  searchMatchRank,
} from "./utils/searchMatch.js";

test("matchSearchText ranks exact, prefix, contains, then subsequence matches", () => {
  assert.equal(matchSearchText("hero", "hero").rank, searchMatchRank.exact);
  assert.equal(matchSearchText("heroprop", "hero").rank, searchMatchRank.prefix);
  assert.equal(matchSearchText("superhero", "hero").rank, searchMatchRank.contains);
  assert.equal(matchSearchText("heroprop", "hrp").rank, searchMatchRank.subsequence);
});

test("matchSearchText supports case-insensitive subsequence fuzzy matching", () => {
  const match = matchSearchText("HeroProp", "hrp");

  assert.equal(match.matched, true);
  assert.equal(match.kind, "subsequence");
  assert.deepEqual(match.ranges, [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 5 },
  ]);
});

test("matchSearchText ranks typo-similar names before scattered subsequence matches", () => {
  const typo = matchSearchText("heroprop", "heropop");
  const scattered = matchSearchText("actthemedrawencmodelprop", "heropop");

  assert.equal(typo.matched, true);
  assert.equal(typo.kind, "similar");
  assert.equal(scattered.matched, true);
  assert.equal(compareSearchMatches(typo, scattered), -1);
});

test("matchSearchText prefers compact subsequence matches over scattered ones", () => {
  const compact = matchSearchText("heroprop", "hrp");
  const scattered = matchSearchText("hxxxxxxxxrxxxxxxxxp", "hrp");

  assert.equal(compact.kind, "subsequence");
  assert.equal(scattered.kind, "subsequence");
  assert.equal(compareSearchMatches(compact, scattered), -1);
});

test("matchSearchText rejects out-of-order subsequence matches", () => {
  assert.equal(matchSearchText("heroprop", "phh").matched, false);
});

test("matchSearchText exact mode keeps strict full-value matching", () => {
  assert.equal(matchSearchText("Needle value", "needle", { mode: "exact" }).matched, false);
  assert.equal(matchSearchText("Needle value", "Needle value", { mode: "exact" }).matched, true);
});

test("highlightSearchText marks continuous and subsequence ranges safely", () => {
  assert.equal(
    highlightSearchText("superhero", "hero"),
    "super<mark>hero</mark>",
  );
  assert.equal(
    highlightSearchText("heroprop", "hrp"),
    "<mark>h</mark>e<mark>r</mark>o<mark>p</mark>rop",
  );
  assert.equal(
    highlightSearchText("<hero>", "hr"),
    "&lt;<mark>h</mark>e<mark>r</mark>o&gt;",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareSearchMatches,
  contiguousSearchPreview,
  highlightSearchText,
  matchSearchText,
  searchMatchRank,
} from "./utils/searchMatch.js";

const searchSemanticsFixture = JSON.parse(
  readFileSync(new URL("./utils/searchSemantics.fixture.json", import.meta.url), "utf8"),
);

function fixtureMatches(fixtureCase) {
  const matches = [];
  fixtureCase.rows.forEach((row, sourceRowIndex) => {
    fixtureCase.columns.forEach((columnName, columnIndex) => {
      const match = matchSearchText(row[columnName], fixtureCase.query, { mode: fixtureCase.mode });
      if (!match.matched) return;
      matches.push({
        sourceRowIndex,
        columnIndex,
        columnName,
        kind: match.kind,
        rank: match.rank,
        score: match.score,
        ranges: match.ranges,
      });
    });
  });
  return matches;
}

test("search semantics golden fixture characterizes ordered JavaScript matches", () => {
  for (const fixtureCase of searchSemanticsFixture.cases) {
    assert.deepEqual(fixtureMatches(fixtureCase), fixtureCase.expected, fixtureCase.name);
  }
});

test("search semantics fixture includes a typo-only hit after the first physical page", () => {
  const fixtureCase = searchSemanticsFixture.cases.find((item) => item.name.startsWith("typo-only"));
  const typoValue = fixtureCase.rows[fixtureCase.physicalPageSize].name;
  const match = matchSearchText(typoValue, fixtureCase.query, { mode: fixtureCase.mode });

  assert.equal(typoValue.toLowerCase().includes(fixtureCase.query.toLowerCase()), false);
  assert.equal(match.kind, "similar");
  assert.ok(fixtureCase.expected[0].sourceRowIndex >= fixtureCase.physicalPageSize);
});

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

test("matchSearchText contains mode requires one contiguous range", () => {
  const contiguous = matchSearchText("prefixAbC21020suffix", "ABC21020", { mode: "contains" });

  assert.equal(contiguous.matched, true);
  assert.equal(contiguous.kind, "contains");
  assert.deepEqual(contiguous.ranges, [{ start: 6, end: 14 }]);
  assert.equal(matchSearchText("2,10,20", "21020", { mode: "contains" }).matched, false);
});

test("highlightSearchText contains mode never highlights separated characters", () => {
  assert.equal(
    highlightSearchText("prefix21020suffix", "21020", { mode: "contains" }),
    "prefix<mark>21020</mark>suffix",
  );
  assert.equal(highlightSearchText("2,10,20", "21020", { mode: "contains" }), "2,10,20");
});

test("contains mode maps case-expanding Unicode matches back to the original text", () => {
  assert.equal(
    highlightSearchText("İprefix21020suffix", "21020", { mode: "contains" }),
    "İprefix<mark>21020</mark>suffix",
  );
});

test("contains mode respects contextual Unicode lowercasing", () => {
  assert.equal(
    highlightSearchText("ΟΣ", "ος", { mode: "contains" }),
    "<mark>ΟΣ</mark>",
  );
});

test("contiguousSearchPreview preserves late matches and Unicode character boundaries", () => {
  const caseExpanding = contiguousSearchPreview(`${"İ".repeat(90)}21020${"x".repeat(200)}`, "21020", 80);
  const emoji = contiguousSearchPreview(`${"😀".repeat(90)}21020${"x".repeat(200)}`, "21020", 80);

  assert.ok(caseExpanding.includes("21020"));
  assert.ok(Array.from(caseExpanding).length <= 80);
  assert.ok(emoji.includes("21020"));
  assert.ok(Array.from(emoji).length <= 80);
  assert.doesNotMatch(emoji, /[\uD800-\uDFFF]/u);
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

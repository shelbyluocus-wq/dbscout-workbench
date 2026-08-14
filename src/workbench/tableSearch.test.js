import test from "node:test";
import assert from "node:assert/strict";

import {
  findBestTableSearchMatch,
  matchTableSearch,
  rankTableSearchResults,
} from "./utils/tableSearch.js";

const tables = [
  { tableName: "doogsprop", tableComment: "fallback" },
  { tableName: "guild_data_profile", tableComment: "ordered but scattered" },
  { tableName: "goodsprop", tableComment: "best ordered match" },
  { tableName: "unrelated", tableComment: "mentions gdp" },
];

test("table search ranks ordered compact names before scattered and unordered matches", () => {
  const results = rankTableSearchResults(tables, "gdp");

  assert.deepEqual(results.map(({ table }) => table.tableName), [
    "goodsprop",
    "guild_data_profile",
    "doogsprop",
    "unrelated",
  ]);
  assert.equal(results[0].match.textMatchKind, "subsequence");
  assert.equal(results[2].match.textMatchKind, "unordered");
});

test("table search keeps table-name matches ahead of comment matches", () => {
  assert.equal(matchTableSearch(tables[0], "gdp").kind, "tableName");
  assert.equal(matchTableSearch(tables[3], "gdp").kind, "tableComment");
  assert.equal(findBestTableSearchMatch(tables, "gdp")?.tableName, "goodsprop");
});

test("table search keeps unordered fallback for short acronyms only", () => {
  assert.equal(matchTableSearch({ tableName: "doogsprop" }, "gdp").textMatchKind, "unordered");
  assert.equal(matchTableSearch({ tableName: "doogsprop" }, "gdps").textMatchKind, "unordered");
  assert.equal(matchTableSearch({ tableName: "challenginskindprop" }, "callerid").matched, false);
  assert.equal(matchTableSearch({ tableName: "heroartifactskilldesprop" }, "callerid").matched, false);
});

test("table search precise mode requires a contiguous case-insensitive match", () => {
  const preciseTables = [
    { tableName: "activityviprewardprop", tableComment: "" },
    { tableName: "activemodpopprop", tableComment: "" },
    { tableName: "unrelated", tableComment: "VIP configuration" },
  ];

  assert.deepEqual(
    rankTableSearchResults(preciseTables, "vip", { mode: "contains" }).map(({ table }) => table.tableName),
    ["activityviprewardprop", "unrelated"],
  );
  assert.equal(matchTableSearch(preciseTables[1], "vip").textMatchKind, "unordered");
  assert.equal(matchTableSearch(preciseTables[1], "vip", { mode: "contains" }).matched, false);
});

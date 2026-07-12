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

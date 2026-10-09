import test from "node:test";
import assert from "node:assert/strict";

import {
  filterTablesByKeywords,
  matchTableKeywords,
  parseSearchKeywords,
  TABLE_KEYWORD_TIER,
} from "./tableKeywordSearch.js";

function names(list) {
  return list.map((table) => table.tableName);
}

function tierOf(tableName, query, tableComment = "") {
  return matchTableKeywords({ tableName, tableComment }, parseSearchKeywords(query)).tier;
}

test("keywords split on any whitespace, lower-case and de-duplicate", () => {
  assert.deepEqual(parseSearchKeywords("  Hero\tPROP　hero  "), ["hero", "prop"]);
  assert.deepEqual(parseSearchKeywords("   "), []);
});

test("every keyword must appear, in any order", () => {
  const tables = [
    { tableName: "hero_prop" },
    { tableName: "prop_hero" },
    { tableName: "heroprop" },
    { tableName: "hero_skill" },
  ];

  assert.deepEqual(names(filterTablesByKeywords(tables, "hero prop")), ["hero_prop", "prop_hero", "heroprop"]);
  assert.deepEqual(names(filterTablesByKeywords(tables, "hero  prop")), names(filterTablesByKeywords(tables, "prop hero")));
  assert.deepEqual(names(filterTablesByKeywords(tables, "hero prop skill")), []);
});

test("keywords may be split between the table name and its comment", () => {
  const tables = [
    { tableName: "hero_cfg", tableComment: "英雄配置表" },
    { tableName: "hero_log", tableComment: "英雄日志" },
  ];

  assert.deepEqual(names(filterTablesByKeywords(tables, "hero 配置")), ["hero_cfg"]);
  assert.equal(tierOf("hero_cfg", "hero 配置", "英雄配置表"), TABLE_KEYWORD_TIER.mixed);
});

test("word-start matches rank between prefix and plain substring matches", () => {
  assert.equal(tierOf("user", "user"), TABLE_KEYWORD_TIER.nameExact);
  assert.equal(tierOf("user_profile", "user"), TABLE_KEYWORD_TIER.namePrefix);
  assert.equal(tierOf("account_user", "user"), TABLE_KEYWORD_TIER.nameWordStart);
  assert.equal(tierOf("accountUser", "user"), TABLE_KEYWORD_TIER.nameWordStart);
  assert.equal(tierOf("HTTPServerLog", "server"), TABLE_KEYWORD_TIER.nameWordStart);
  assert.equal(tierOf("log2024", "2024"), TABLE_KEYWORD_TIER.nameWordStart);
  assert.equal(tierOf("superuser", "user"), TABLE_KEYWORD_TIER.nameContains);
  // A later occurrence at a word start wins over an earlier mid-word one.
  assert.equal(tierOf("superuser_user", "user"), TABLE_KEYWORD_TIER.nameWordStart);
  // With several keywords, the weakest keyword decides the tier.
  assert.equal(tierOf("hero_prop", "hero prop"), TABLE_KEYWORD_TIER.nameWordStart);
  assert.equal(tierOf("heroprop", "hero prop"), TABLE_KEYWORD_TIER.nameContains);
});

test("name matches outrank mixed matches, which outrank comment-only matches", () => {
  const tables = [
    { tableName: "misc", tableComment: "user data" },
    { tableName: "superuser", tableComment: "" },
    { tableName: "user_misc", tableComment: "" },
    { tableName: "account_user", tableComment: "" },
    { tableName: "user", tableComment: "" },
  ];

  assert.deepEqual(names(filterTablesByKeywords(tables, "user")), [
    "user",
    "user_misc",
    "account_user",
    "superuser",
    "misc",
  ]);
});

test("tables within one tier keep the input order", () => {
  const tables = [
    { tableName: "act_2" },
    { tableName: "act_10" },
    { tableName: "zz_act" },
    { tableName: "act_1" },
  ];

  assert.deepEqual(names(filterTablesByKeywords(tables, "act")), ["act_2", "act_10", "act_1", "zz_act"]);
  assert.equal(filterTablesByKeywords(tables, " "), tables);
});

test("highlight ranges cover each keyword in each field", () => {
  const match = matchTableKeywords(
    { tableName: "superuser_user_prop", tableComment: "User prop table" },
    parseSearchKeywords("user prop"),
  );

  assert.deepEqual(match.nameRanges, [{ start: 10, end: 14 }, { start: 15, end: 19 }]);
  assert.deepEqual(match.commentRanges, [{ start: 0, end: 4 }, { start: 5, end: 9 }]);
});

test("case-folding that changes text length keeps source ranges", () => {
  const match = matchTableKeywords({ tableName: "İtem_list" }, parseSearchKeywords("list"));

  assert.equal(match.matched, true);
  assert.deepEqual(match.nameRanges, [{ start: 5, end: 9 }]);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeLocaleTableGroups,
  applyLocaleTableFolding,
  matchWildcardTableNames,
  splitLocaleTableName,
} from "./localeTableGrouping.js";

test("splitLocaleTableName recognizes localized game-config suffixes", () => {
  assert.deepEqual(splitLocaleTableName("goodsprop_en"), { baseName: "goodsprop", suffix: "_en" });
  assert.deepEqual(splitLocaleTableName("goodsprop_en2"), { baseName: "goodsprop", suffix: "_en2" });
  assert.deepEqual(splitLocaleTableName("heroprop_TW"), { baseName: "heroprop", suffix: "_tw" });
  assert.deepEqual(splitLocaleTableName("actprop_kr"), { baseName: "actprop", suffix: "_kr" });
  assert.equal(splitLocaleTableName("goodsprop"), null);
  assert.equal(splitLocaleTableName("user_id"), null);
});

test("analyzeLocaleTableGroups only groups variants when the base table exists", () => {
  const tables = [
    { tableName: "goodsprop" },
    { tableName: "goodsprop_en" },
    { tableName: "goodsprop_tw" },
    { tableName: "goodsprop_en2" },
    { tableName: "orphan_en" },
    { tableName: "user_id" },
  ];
  const info = analyzeLocaleTableGroups(tables);
  assert.equal(info.variantCount, 3);
  assert.equal(info.variantToBase.has("orphan_en"), false);
  assert.deepEqual(
    info.variantsByBase.get("goodsprop").map((item) => item.name),
    ["goodsprop_en", "goodsprop_en2", "goodsprop_tw"],
  );
});

test("applyLocaleTableFolding folds variants under their base and supports per-base expansion", () => {
  const tables = [
    { tableName: "goodsprop" },
    { tableName: "goodsprop_en" },
    { tableName: "goodsprop_tw" },
    { tableName: "heroprop" },
  ];

  const folded = applyLocaleTableFolding(tables, { fold: true });
  assert.deepEqual(folded.rows.map((r) => r.tableName), ["goodsprop", "heroprop"]);
  assert.equal(folded.hiddenVariantCount, 2);
  assert.equal(folded.localeMetaByName.get("goodsprop")?.variantCount, 2);
  assert.equal(folded.localeMetaByName.get("goodsprop")?.expanded, false);

  const expanded = applyLocaleTableFolding(tables, {
    fold: true,
    expandedBases: new Set(["goodsprop"]),
  });
  assert.deepEqual(
    expanded.rows.map((r) => r.tableName),
    ["goodsprop", "goodsprop_en", "goodsprop_tw", "heroprop"],
  );
  assert.equal(expanded.hiddenVariantCount, 0);
  assert.equal(expanded.localeMetaByName.get("goodsprop_tw")?.kind, "variant");
  assert.equal(expanded.localeMetaByName.get("goodsprop_tw")?.suffix, "_tw");

  // Searching explicitly for a locale suffix reveals the variants automatically.
  const searched = applyLocaleTableFolding(tables, { fold: true, query: "_tw" });
  assert.equal(searched.rows.length, 4);
  assert.equal(searched.hiddenVariantCount, 0);
});

test("matchWildcardTableNames matches multiple glob and substring rules case-insensitively", () => {
  const names = ["goodsprop", "goodsprop_en", "goodsprop_en2", "goodsprop_tw", "heroprop_kr", "log_2026_01"];
  assert.deepEqual(
    matchWildcardTableNames(names, "*_en*, *_tw"),
    ["goodsprop_en", "goodsprop_en2", "goodsprop_tw"],
  );
  assert.deepEqual(
    matchWildcardTableNames(names, "log_202?_01"),
    ["log_2026_01"],
  );
  assert.deepEqual(
    matchWildcardTableNames(names, "_kr"),
    ["heroprop_kr"],
  );
});

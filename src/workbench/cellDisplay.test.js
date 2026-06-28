import test from "node:test";
import assert from "node:assert/strict";
import { formatDetailValue, highlightCell, highlightCellResult, highlightDetailValue } from "./utils/cellDisplay.js";

test("formatDetailValue pretty prints and highlights JSON objects", () => {
  const result = formatDetailValue('{"enabled":true,"count":3,"items":["a",null]}');

  assert.equal(result.kind, "json");
  assert.match(result.text, /\n  "enabled": true/);
  assert.match(result.html, /wb-token-key/);
  assert.match(result.html, /wb-token-number/);
  assert.match(result.html, /wb-token-literal/);
});

test("formatDetailValue leaves invalid JSON as plain text", () => {
  const result = formatDetailValue("{not json}");

  assert.equal(result.kind, "text");
  assert.equal(result.text, "{not json}");
});

test("formatDetailValue highlights TypeScript-like functions", () => {
  const result = formatDetailValue("export const run = (input: Foo) => { return input.id > 1; };");

  assert.equal(result.kind, "typescript");
  assert.match(result.html, /wb-token-keyword/);
  assert.match(result.html, /wb-token-function/);
});

test("formatDetailValue escapes HTML before preview rendering", () => {
  const result = formatDetailValue("<script>alert(1)</script>");

  assert.equal(result.kind, "text");
  assert.equal(result.html, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("highlightDetailValue highlights JSON without changing editor text", () => {
  const raw = '{"enabled":true,"count":3}';
  const result = highlightDetailValue(raw);

  assert.equal(result.kind, "json");
  assert.equal(result.text, raw);
  assert.match(result.html, /wb-token-key/);
});

test("highlightDetailValue highlights TypeScript without changing editor text", () => {
  const raw = "const run = () => 1;";
  const result = highlightDetailValue(raw);

  assert.equal(result.kind, "typescript");
  assert.equal(result.text, raw);
  assert.match(result.html, /wb-token-keyword/);
});

test("highlightCell marks continuous and subsequence table search matches", () => {
  const tab = {
    tableName: "hero",
    searchQuery: "hrp",
    filterMode: "fuzzy",
    primaryKeys: ["id"],
  };

  assert.equal(
    highlightCell({}, tab, { id: "1", name: "HeroProp" }, "name", "id=1"),
    "<mark>H</mark>e<mark>r</mark>o<mark>P</mark>rop",
  );

  tab.searchQuery = "hero";
  assert.equal(
    highlightCell({}, tab, { id: "1", name: "SuperHero" }, "name", "id=1"),
    "Super<mark>Hero</mark>",
  );
});

test("highlightCellResult returns escaped html and match state together", () => {
  const tab = {
    tableName: "hero",
    searchQuery: "hero",
    filterMode: "fuzzy",
    primaryKeys: ["id"],
  };

  assert.deepEqual(
    highlightCellResult({}, tab, { id: "1", name: "<Hero>" }, "name", "id=1"),
    {
      html: "&lt;<mark>Hero</mark>&gt;",
      matched: true,
    },
  );

  assert.deepEqual(
    highlightCellResult({}, tab, { id: "2", name: "<Other>" }, "name", "id=2"),
    {
      html: "&lt;Other&gt;",
      matched: false,
    },
  );
});

test("highlightCellResult caches repeated visible-cell highlights", () => {
  const tab = {
    tableName: "hero",
    searchQuery: "hero",
    filterMode: "fuzzy",
    primaryKeys: ["id"],
  };
  const editState = {};
  const row = { id: "1", name: "Hero" };

  const first = highlightCellResult(editState, tab, row, "name", "id=1");
  const second = highlightCellResult(editState, tab, row, "name", "id=1");

  assert.equal(first, second);
});

test("highlightCell does not mark NULL display values", () => {
  const tab = {
    tableName: "hero",
    searchQuery: "nu",
    filterMode: "fuzzy",
    primaryKeys: ["id"],
  };

  assert.equal(highlightCell({}, tab, { id: "1", name: null }, "name", "id=1"), "NULL");
});

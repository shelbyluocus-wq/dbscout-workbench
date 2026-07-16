import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("./components/SqlCodeEditor.vue", import.meta.url), "utf8");
const theme = readFileSync(new URL("./utils/sqlEditorTheme.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

test("SQL editor uses the product theme instead of CodeMirror default colors", () => {
  assert.match(component, /sqlSyntaxHighlighting/);
  assert.doesNotMatch(component, /defaultHighlightStyle/);
  assert.match(theme, /HighlightStyle\.define/);
  assert.match(theme, /var\(--wb-sql-keyword\)/);
});

test("SQL syntax and editor states define readable light and dark theme tokens", () => {
  const tokens = ["keyword", "string", "number", "comment", "type", "function", "operator", "identifier", "invalid", "match"];
  for (const token of tokens) {
    const occurrences = styles.match(new RegExp(`--wb-sql-${token}:`, "g")) || [];
    assert.equal(occurrences.length, 2, `expected light and dark values for --wb-sql-${token}`);
  }
  for (const state of ["cm-activeLineGutter", "cm-matchingBracket", "cm-nonmatchingBracket", "cm-searchMatch", "cm-selectionMatch"]) {
    assert.match(styles, new RegExp(`\\.${state}`), `missing themed ${state} state`);
  }
});

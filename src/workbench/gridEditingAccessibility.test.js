import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("the virtualized data grid exposes complete keyboard and screen-reader semantics", () => {
  const grid = read("components/DataGrid.vue");

  assert.match(grid, /role="grid"/);
  assert.match(grid, /:aria-rowcount="gridAriaRowCount"/);
  assert.match(grid, /:aria-colcount="1 \+ activeColumns\.length"/);
  assert.match(grid, /:aria-activedescendant="activeCellDomId \|\| undefined"/);
  assert.match(grid, /role="columnheader"/);
  assert.match(grid, /role="rowheader"/);
  assert.match(grid, /role="gridcell"/);
  assert.match(grid, /:aria-invalid=/);
  assert.match(grid, /:aria-busy=/);
});

test("SQL NULL and unsaved inserts have non-color-only visible affordances", () => {
  const grid = read("components/DataGrid.vue");
  const styles = read("workbench.css");

  assert.match(grid, /class="wb-null-badge"/);
  assert.match(grid, />NULL</);
  assert.match(styles, /\.wb-null-badge\s*\{/);
  assert.match(grid, /wb-insert-row-actions/);
  assert.match(grid, /emit\('save-insert-row'/);
  assert.match(grid, /emit\('cancel-insert-row'/);
  assert.match(styles, /\.wb-insert-row-actions\s*\{/);
});

test("the detail panel saves only drafts the user actually changed", () => {
  const detail = read("components/CellDetailPanel.vue");

  assert.match(detail, /const isDraftDirty = ref\(false\)/);
  assert.match(detail, /if \(!isDraftDirty\.value\) return/);
  assert.match(detail, /dirty: true/);
  assert.match(detail, /wb-cell-detail-null-state/);
});

test("the focused detail editor uses one text renderer and the native text cursor", () => {
  const styles = read("workbench.css");

  assert.match(styles, /(?:^|\r?\n)\.wb-detail-input\s*\{[^}]*cursor:\s*text/s);
  assert.match(
    styles,
    /\.wb-detail-editor\.has-highlight:not\(:focus-within\) \.wb-detail-input\s*\{[^}]*color:\s*transparent/s,
  );
  assert.match(
    styles,
    /\.wb-detail-editor\.has-highlight:focus-within \.wb-detail-highlights\s*\{[^}]*visibility:\s*hidden/s,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("sidebar search resets the result viewport when the query changes", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(sidebar, /scrollSidebarSearchResultsToTop/);
  assert.match(sidebar, /watch\(\s*\r?\n\s*\(\)\s*=>\s*props\.treeQuery/);
  assert.match(sidebar, /nextTick\(\(\)\s*=>\s*\{/);
  assert.match(sidebar, /scrollSidebarSearchResultsToTop\(treeNavRef\.value\)/);
});

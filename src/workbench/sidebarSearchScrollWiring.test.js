import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("sidebar reveals the search context only when entering search (no per-keystroke scroll)", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(sidebar, /revealSidebarSearchResults/);
  assert.match(sidebar, /watch\(\s*\r?\n\s*\(\)\s*=>\s*props\.treeQuery/);
  // Only fire on the empty -> non-empty transition, staying put while editing/clearing.
  assert.match(sidebar, /const\s+entering\s*=\s*nowSearching\s*&&\s*!wasSearching/);
  assert.match(sidebar, /if\s*\(!entering\)\s*return/);
  assert.match(sidebar, /nextTick\(\(\)\s*=>\s*\{/);
  assert.match(sidebar, /scrollContainer:\s*tableScrollElement/);
  assert.match(sidebar, /const\s+container\s*=\s*tableScrollElement\(\)/);
  assert.match(sidebar, /container\.scrollTo\(\{\s*top:\s*0,\s*behavior:\s*"auto"\s*\}\)/);
  assert.match(sidebar, /requestAnimationFrame\(\(\)\s*=>\s*\{/);
  assert.match(sidebar, /revealSidebarSearchResults\(tableScrollElement\(\),\s*\{\s*smooth:\s*false\s*\}\)/);
  assert.doesNotMatch(sidebar, /revealSidebarSearchResults\(treeNavRef\.value/);
});

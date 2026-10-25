import assert from "node:assert/strict";
import { test } from "node:test";
import { DIFF_LINE, diffRows, diffStats, differingRanges, expandTabs, parseHunks, parseUnifiedDiff, sideBySideRows } from "./unifiedDiff.js";

const SVN_DIFF = [
  "Index: assets/src/modules/hero/HeroMgr.ts",
  "===================================================================",
  "--- assets/src/modules/hero/HeroMgr.ts\t(revision 52817)",
  "+++ assets/src/modules/hero/HeroMgr.ts\t(working copy)",
  "@@ -177,4 +177,5 @@",
  "         const prop = heroprops[i];",
  "-            if(this.getIsHeroID(prop.ID) && !prop.IsNpc){",
  "+            if(this.getIsHeroID(prop.ID) && prop.OpenFlag && !prop.IsNpc){",
  "+                // open heroes only",
  "             if (this._ownedHeros.has(prop.ID)) {",
  "\\ No newline at end of file",
  "Index: assets/props/propsH5/props.bin",
  "===================================================================",
  "Cannot display: file marked as a binary type.",
  "svn:mime-type = application/octet-stream",
  "Index: assets/bundles",
  "===================================================================",
  "",
  "Property changes on: assets/bundles",
  "___________________________________________________________________",
  "Modified: svn:ignore",
  "## -1 +1,2 ##",
  "-*.log",
  "+*.log",
  "+temp",
].join("\r\n");

test("svn diff output splits into files with numbered hunks, binaries and property changes", () => {
  const [code, binary, folder] = parseUnifiedDiff(SVN_DIFF);
  assert.equal(code.path, "assets/src/modules/hero/HeroMgr.ts");
  assert.equal(code.hunks.length, 1);
  const lines = code.hunks[0].lines;
  assert.deepEqual(lines.map((line) => [line.kind, line.oldNumber, line.newNumber]), [
    [DIFF_LINE.CONTEXT, 177, 177],
    [DIFF_LINE.REMOVED, 178, null],
    [DIFF_LINE.ADDED, null, 178],
    [DIFF_LINE.ADDED, null, 179],
    [DIFF_LINE.CONTEXT, 179, 180],
  ]);
  assert.equal(lines.at(-1).missingNewline, true);
  assert.deepEqual(diffStats(code), { added: 2, removed: 1 });
  assert.equal(binary.binary, true);
  assert.equal(binary.hunks.length, 0);
  assert.deepEqual(folder.properties.map((property) => [property.change, property.name, property.lines.length]), [["Modified", "svn:ignore", 3]]);
});

test("the changed part of a replaced line is highlighted when enough of it stays", () => {
  const [code] = parseUnifiedDiff(SVN_DIFF);
  const [removed, added] = code.hunks[0].lines.slice(1, 3);
  assert.equal(added.text.slice(added.highlight.start, added.highlight.end), "prop.OpenFlag && ");
  assert.deepEqual(removed.highlight, { start: removed.text.indexOf("!prop"), end: removed.text.indexOf("!prop") });
  assert.equal(differingRanges("abc", "abc"), null);
  assert.equal(differingRanges("short", "a completely different line"), null, "too different to help");
  // A surrogate pair is never cut in half.
  const ranges = differingRanges("a😀b", "a😁b");
  assert.deepEqual(ranges, { old: { start: 1, end: 3 }, new: { start: 1, end: 3 } });
});

test("side by side pairs removed lines with the added lines that replaced them", () => {
  const [hunk] = parseHunks(["@@ -1,4 +1,4 @@", " a", "-b", "-c", "+B", " d"]);
  const rows = sideBySideRows(hunk);
  assert.deepEqual(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null]), [
    ["a", "a"], ["b", "B"], ["c", null], ["d", "d"],
  ]);
  const split = diffRows({ hunks: [hunk], properties: [] }, "split");
  assert.deepEqual(split.map((row) => row.type), ["hunk", "split", "split", "split", "split"]);
  assert.deepEqual(split.filter((row) => row.startsChange).length, 1, "one block of changes, one stop");
  const unified = diffRows({ hunks: [hunk], properties: [] }, "unified");
  assert.deepEqual(unified.slice(1).map((row) => [row.cell.kind, row.oldNumber, row.newNumber]), [
    ["context", 1, 1], ["removed", 2, null], ["removed", 3, null], ["added", null, 2], ["context", 4, 3],
  ]);
});

test("tabs expand to stops and carry the highlight along", () => {
  assert.deepEqual(expandTabs("\tx", { start: 1, end: 2 }), { text: "    x", highlight: { start: 4, end: 5 } });
  assert.deepEqual(expandTabs("ab\tc"), { text: "ab  c", highlight: null });
});

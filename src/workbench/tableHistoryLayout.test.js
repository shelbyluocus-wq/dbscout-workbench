import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildChangeMapSegments,
  buildPlaceholderLabelIndices,
  groupRevisionsByDay,
  isSameFrozenLayout,
  orderPrimaryKeyColumnsFirst,
  resolveColumnRevealScroll,
  resolveFrozenColumns,
} from "./utils/tableHistoryLayout.js";

const widths = { TaskLine: 120, TaskIdx: 90, TaskType: 140, Name: 160, Desc: 220 };
const widthOf = (name) => widths[name];
const columns = [
  { name: "TaskLine", primaryKey: true },
  { name: "TaskIdx", primaryKey: true },
  { name: "TaskType" },
  { name: "Name" },
  { name: "Desc" },
];

test("orderPrimaryKeyColumnsFirst keeps leading keys in place and moves trailing keys forward", () => {
  assert.equal(orderPrimaryKeyColumnsFirst(columns), columns);
  const shuffled = [columns[2], columns[0], columns[3], columns[1]];
  assert.deepEqual(orderPrimaryKeyColumnsFirst(shuffled).map((col) => col.name), ["TaskLine", "TaskIdx", "TaskType", "Name"]);
  assert.deepEqual(orderPrimaryKeyColumnsFirst([]), []);
});

test("resolveFrozenColumns pins leading primary keys within the pane budget", () => {
  const wide = resolveFrozenColumns({ columns, widthOf, rowNumWidth: 44, paneWidth: 900 });
  assert.deepEqual([...wide.offsets], [["TaskLine", 44], ["TaskIdx", 164]]);
  assert.equal(wide.width, 254);
  assert.equal(wide.lastName, "TaskIdx");

  const narrow = resolveFrozenColumns({ columns, widthOf, rowNumWidth: 44, paneWidth: 360 });
  assert.deepEqual([...narrow.offsets.keys()], ["TaskLine"], "second key would exceed 55% of a narrow pane");

  assert.ok(isSameFrozenLayout(wide, resolveFrozenColumns({ columns, widthOf, rowNumWidth: 44, paneWidth: 1200 })), "resizes that keep the pinned set reuse the layout");
  assert.ok(!isSameFrozenLayout(wide, narrow));

  const none = resolveFrozenColumns({ columns: columns.slice(2), widthOf, rowNumWidth: 44, paneWidth: 900 });
  assert.equal(none.offsets.size, 0);
  assert.equal(none.width, 44);
  assert.equal(none.lastName, "");
});

test("resolveColumnRevealScroll snaps the target beside the frozen block and skips visible or frozen targets", () => {
  const frozen = resolveFrozenColumns({ columns, widthOf, rowNumWidth: 44, paneWidth: 900 });
  const base = { columns, widthOf, rowNumWidth: 44, frozen };
  // Column starts: TaskType 254, Name 394, Desc 554 (ends 774).
  assert.equal(resolveColumnRevealScroll({ ...base, targetCol: "Name", scrollLeft: 0, clientWidth: 600 }), null);
  assert.equal(resolveColumnRevealScroll({ ...base, targetCol: "TaskIdx", scrollLeft: 300, clientWidth: 400 }), null);
  assert.equal(
    resolveColumnRevealScroll({ ...base, targetCol: "Desc", scrollLeft: 0, clientWidth: 700 }),
    140,
    "Name starts flush against the frozen edge while Desc fits completely",
  );
  assert.equal(
    resolveColumnRevealScroll({ ...base, targetCol: "Desc", scrollLeft: 0, clientWidth: 400 }),
    300,
    "a target wider than the remaining space aligns its own start to the frozen edge",
  );
  assert.equal(
    resolveColumnRevealScroll({ ...base, targetCol: "TaskType", scrollLeft: 300, clientWidth: 560 }),
    0,
    "scrolling back left restores the first unfrozen column",
  );
});

test("buildChangeMapSegments merges touching rows of one status and keeps statuses apart", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ status: "unchanged", rowIndex: index }));
  for (const i of [10, 11, 12]) rows[i].status = "updated";
  rows[13].status = "inserted";
  rows[90].status = "deleted";
  rows[99].status = "inserted";
  const indices = rows.flatMap((row, index) => (row.status === "unchanged" ? [] : [index]));
  const segments = buildChangeMapSegments({ rows, indices, trackHeight: 200, minHeight: 4 });

  assert.deepEqual(segments.map((s) => [s.status, s.firstIndex, s.lastIndex, s.count]), [
    ["updated", 10, 12, 3],
    ["inserted", 13, 13, 1],
    ["deleted", 90, 90, 1],
    ["inserted", 99, 99, 1],
  ]);
  assert.equal(segments[0].top, 20);
  assert.equal(segments[0].height, 6);
  assert.equal(segments[2].height, 4, "single rows keep the minimum visible height");
  assert.ok(segments[3].top + segments[3].height <= 200, "last segment stays inside the track");
  assert.deepEqual(buildChangeMapSegments({ rows, indices, trackHeight: 0 }), []);
});

test("buildPlaceholderLabelIndices labels each missing-row run once and repeats inside long runs", () => {
  const statuses = ["unchanged", "inserted", "inserted", "inserted", "deleted", "deleted", "updated", "inserted"];
  const rows = statuses.map((status) => ({ status }));
  assert.deepEqual([...buildPlaceholderLabelIndices(rows, 12)], [1, 4, 7]);
  assert.deepEqual([...buildPlaceholderLabelIndices(rows, 2)], [1, 3, 4, 7]);
});

test("groupRevisionsByDay groups consecutive revisions under today, yesterday and dated headers", () => {
  const nowMs = new Date(2026, 10, 25, 15, 0, 0).getTime();
  const at = (y, m, d, h = 10) => ({ tsMs: new Date(y, m - 1, d, h).getTime() });
  const revisions = [at(2026, 11, 25, 13), at(2026, 11, 25, 9), at(2026, 11, 24), at(2026, 11, 2), at(2025, 10, 22), { tsMs: 0 }];
  const groups = groupRevisionsByDay(revisions, { nowMs });
  assert.deepEqual(groups.map((g) => [g.kind, g.label, g.items.length]), [
    ["today", "", 2],
    ["yesterday", "", 1],
    ["date", "11-02", 1],
    ["date", "2025-10-22", 1],
    ["unknown", "", 1],
  ]);
});

test("TableChangeHistoryView wires frozen keys, change map, labelled placeholders and day groups", () => {
  const view = readFileSync(new URL("./components/TableChangeHistoryView.vue", import.meta.url), "utf8");
  const map = readFileSync(new URL("./components/TableHistoryChangeMap.vue", import.meta.url), "utf8");
  const css = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

  assert.equal((view.match(/'is-frozen': frozenLayout\.offsets\.has\(col\.name\)/g) || []).length, 6, "both headers and all four body grids pin keys");
  assert.equal((view.match(/placeholderLabelIndices\.has\(/g) || []).length, 4);
  assert.match(view, /<TableHistoryChangeMap[\s\S]*?v-if="showChangeMap"[\s\S]*?@jump="handleChangeMapJump"[\s\S]*?@seek="handleChangeMapSeek"/);
  assert.match(view, /v-for="group in revisionGroups"/);
  assert.match(view, /resolveColumnRevealScroll\(/);
  assert.doesNotMatch(map, /translateY\(/, "map thumb moves with top, not transforms, to stay crisp under zoom");

  assert.match(css, /\.wb-thv-cell\.is-frozen\s*\{[^}]*position:\s*sticky[^}]*background:\s*inherit/s);
  assert.match(css, /\.wb-thv-cell\.is-placeholder\s*\{[^}]*overflow:\s*clip/s, "sticky placeholder labels need a non-scrolling clip");
  assert.match(css, /\.wb-thv-day-head\s*\{[^}]*position:\s*sticky/s);
});

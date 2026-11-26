import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeHysteresisVirtualWindow,
  createDualPaneScrollSync,
} from "./utils/tableHistoryScrollSync.js";
import { buildHistoryRestorePlan } from "./utils/tableHistoryRestore.js";
import { groupAuditRevisions, mergeTableAuditEntries } from "./utils/tableChangeHistory.js";
import { createMockAuditHistory } from "./mock/mockAuditHistory.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";
import en from "./i18n/en.js";

test("createDualPaneScrollSync prevents WebKit delayed-echo ping-pong jitter during momentum scrolling", () => {
  let clock = 1000;
  const before = { scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 400, scrollWidth: 2000, clientWidth: 500 };
  const after = { scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 400, scrollWidth: 2000, clientWidth: 500 };
  const synced = [];

  const sync = createDualPaneScrollSync({
    getBefore: () => before,
    getAfter: () => after,
    onSync: (ev) => synced.push(ev),
    now: () => clock,
  });

  // User starts scrolling the left ("before") pane via trackpad wheel.
  sync.claimDriver("before");
  before.scrollTop = 120;
  assert.equal(sync.handleScroll("before"), true);
  assert.equal(after.scrollTop, 120);

  // Frame 2 (+16ms): user's momentum advances before to 180, while WebKit delivers
  // the delayed scroll echo from `after` at 120. It MUST NOT snap `before` back!
  clock += 16;
  before.scrollTop = 180;
  after.scrollTop = 120;
  assert.equal(sync.handleScroll("after"), false);
  assert.equal(before.scrollTop, 180, "delayed peer echo must never pull active scroller backwards");

  assert.equal(sync.handleScroll("before"), true);
  assert.equal(after.scrollTop, 180);

  // Negative rubber-band overscroll on macOS clamps cleanly to 0 on peer.
  clock += 16;
  before.scrollTop = -14;
  assert.equal(sync.handleScroll("before"), true);
  assert.equal(after.scrollTop, 0);

  // User moves pointer/wheel to the right ("after") pane: immediate handoff!
  clock += 16;
  sync.claimDriver("after");
  after.scrollTop = 320;
  after.scrollLeft = 90;
  assert.equal(sync.handleScroll("after"), true);
  assert.equal(before.scrollTop, 320);
  assert.equal(before.scrollLeft, 90);
});

test("createDualPaneScrollSync suppresses echoes after programmatic scrollBothTo", () => {
  let clock = 2000;
  const before = { scrollTop: 0, scrollLeft: 0, scrollHeight: 3000, clientHeight: 400, scrollWidth: 1600, clientWidth: 400 };
  const after = { scrollTop: 0, scrollLeft: 0, scrollHeight: 3000, clientHeight: 400, scrollWidth: 1600, clientWidth: 400 };
  const events = [];

  const sync = createDualPaneScrollSync({
    getBefore: () => before,
    getAfter: () => after,
    onSync: (ev) => events.push(ev),
    now: () => clock,
  });

  sync.scrollBothTo(450, 80);
  assert.equal(before.scrollTop, 450);
  assert.equal(after.scrollTop, 450);
  assert.equal(before.scrollLeft, 80);
  assert.equal(after.scrollLeft, 80);
  assert.equal(events.at(-1)?.force, true);

  clock += 20;
  assert.equal(sync.handleScroll("before"), false);
  assert.equal(sync.handleScroll("after"), false);
});

test("computeHysteresisVirtualWindow keeps small tables unvirtualized and avoids churn inside buffer", () => {
  assert.deepEqual(
    computeHysteresisVirtualWindow({ total: 80, scrollTop: 600, viewportHeight: 420, rowHeight: 30 }),
    { start: 0, end: 80 },
  );

  // Large table: initial window centered at scrollTop = 900 (row 30)
  const w1 = computeHysteresisVirtualWindow({
    total: 1000,
    scrollTop: 900,
    viewportHeight: 420,
    rowHeight: 30,
    bufferRows: 20,
    triggerMargin: 8,
    currentStart: 0,
    force: true,
  });
  assert.equal(w1.start, 10);

  // Scrolling 5 rows (150px) inside the buffer must NOT change window start/end!
  const w2 = computeHysteresisVirtualWindow({
    total: 1000,
    scrollTop: 1050,
    viewportHeight: 420,
    rowHeight: 30,
    bufferRows: 20,
    triggerMargin: 8,
    currentStart: w1.start,
    force: false,
  });
  assert.deepEqual(w2, w1);

  // Scrolling past the trigger margin smoothly recenters.
  const w3 = computeHysteresisVirtualWindow({
    total: 1000,
    scrollTop: 1500,
    viewportHeight: 420,
    rowHeight: 30,
    bufferRows: 20,
    triggerMargin: 8,
    currentStart: w1.start,
    force: false,
  });
  assert.ok(w3.start > w1.start);
});

test("buildHistoryRestorePlan computes minimal net operations for before/after across local and shared edits", () => {
  const columns = [
    { name: "ID", primaryKey: true, isGenerated: false },
    { name: "Name", primaryKey: false, isGenerated: false },
    { name: "Val", primaryKey: false, isGenerated: false },
  ];
  const primaryKeys = ["ID"];
  // Current live state after 3 revisions:
  // rev[2] (oldest): updated ID=1 Name 'A' -> 'B', deleted ID=3 ('C', '30')
  // rev[1] (middle): inserted ID=4 ('D', '40')
  // rev[0] (newest, teammate shared): updated ID=1 Name 'B' -> 'B2'
  const liveRows = [
    { ID: 1, Name: "B2", Val: "10" },
    { ID: 2, Name: "Keep", Val: "20" },
    { ID: 4, Name: "D", Val: "40" },
  ];

  const merged = mergeTableAuditEntries({
    localEntries: [
      {
        id: 10,
        clientId: "c-insert",
        ts: "2026-11-24T10:05:00Z",
        operation: "INSERT",
        rowIdentity: { ID: 4 },
        newValue: JSON.stringify({ ID: 4, Name: "D", Val: "40" }),
        status: "committed",
        source: "grid",
        actor: "我",
      },
      {
        id: 8,
        clientId: "c-upd1",
        ts: "2026-11-24T10:00:00Z",
        operation: "UPDATE",
        rowIdentity: { ID: 1 },
        columnName: "Name",
        oldValue: "A",
        newValue: "B",
        status: "committed",
        source: "grid",
        actor: "我",
      },
      {
        id: 7,
        clientId: "c-del3",
        ts: "2026-11-24T10:00:00.500Z",
        operation: "DELETE",
        rowIdentity: { ID: 3 },
        oldValue: JSON.stringify({ ID: 3, Name: "C", Val: "30" }),
        status: "committed",
        source: "grid",
        actor: "我",
      },
    ],
    sharedEntries: [
      {
        clientId: "c-shared-upd",
        ts: "2026-11-24T10:10:00Z",
        displayName: "杨奭宸",
        operation: "UPDATE",
        rowIdentity: { ID: 1 },
        columnName: "Name",
        oldValue: "B",
        newValue: "B2",
        status: "committed",
        source: "grid",
      },
    ],
  });
  const revisions = groupAuditRevisions(merged);
  assert.equal(revisions.length, 3);

  // Restore to BEFORE rev[0] (teammate's update): updates ID=1 Name B2 -> B
  const beforeLatest = buildHistoryRestorePlan({
    columns,
    primaryKeys,
    liveRows,
    revisions,
    targetIndex: 0,
    target: "before",
  });
  assert.equal(beforeLatest.canRestore, true);
  assert.deepEqual(beforeLatest.counts, { insert: 0, update: 1, delete: 0, total: 1 });
  assert.deepEqual(beforeLatest.operations[0], {
    kind: "update",
    rowIdentity: { ID: "1" },
    expectedCurrent: { Name: "B2" },
    targetValues: { Name: "B" },
  });

  // Restore to AFTER rev[0] is already live
  const afterLatest = buildHistoryRestorePlan({
    columns,
    primaryKeys,
    liveRows,
    revisions,
    targetIndex: 0,
    target: "after",
  });
  assert.equal(afterLatest.canRestore, false);
  assert.equal(afterLatest.reason, "already-current");

  // Restore to AFTER rev[2] (undoes rev[0] and rev[1]): update ID=1 B2->B, delete ID=4
  const afterOldest = buildHistoryRestorePlan({
    columns,
    primaryKeys,
    liveRows,
    revisions,
    targetIndex: 2,
    target: "after",
  });
  assert.equal(afterOldest.canRestore, true);
  assert.deepEqual(afterOldest.counts, { insert: 0, update: 1, delete: 1, total: 2 });

  // Restore to BEFORE rev[2] (undoes all 3): update ID=1 B2->A, delete ID=4, re-insert ID=3
  const beforeOldest = buildHistoryRestorePlan({
    columns,
    primaryKeys,
    liveRows,
    revisions,
    targetIndex: 2,
    target: "before",
  });
  assert.equal(beforeOldest.canRestore, true);
  assert.deepEqual(beforeOldest.counts, { insert: 1, update: 1, delete: 1, total: 3 });
  assert.equal(beforeOldest.operations.find((op) => op.kind === "update")?.targetValues?.Name, "A");
  assert.deepEqual(beforeOldest.operations.find((op) => op.kind === "insert")?.targetValues, {
    ID: "3",
    Name: "C",
    Val: "30",
  });
});

test("buildHistoryRestorePlan blocks DDL, missing rowIdentity, and no-PK tables honestly", () => {
  const columns = [{ name: "ID", primaryKey: true }, { name: "Name", primaryKey: false }];
  const liveRows = [{ ID: 1, Name: "New" }];

  const noPk = buildHistoryRestorePlan({
    columns,
    primaryKeys: [],
    liveRows,
    revisions: [{ id: "r1", items: [] }],
    targetIndex: 0,
  });
  assert.equal(noPk.canRestore, false);
  assert.equal(noPk.reason, "no-primary-key");

  const missingIdentity = buildHistoryRestorePlan({
    columns,
    primaryKeys: ["ID"],
    liveRows,
    revisions: [{
      id: "r1",
      items: [{ operation: "UPDATE", rowIdentity: [], changes: [{ field: "Name", before: { text: "Old" }, after: { text: "New" } }] }],
    }],
    targetIndex: 0,
  });
  assert.equal(missingIdentity.canRestore, false);
  assert.equal(missingIdentity.reason, "missing-row-identity");

  const hasDdl = buildHistoryRestorePlan({
    columns,
    primaryKeys: ["ID"],
    liveRows,
    revisions: [{
      id: "r1",
      items: [{ operation: "DDL", rowIdentity: [], ddlItems: ["ALTER TABLE"] }],
    }],
    targetIndex: 0,
  });
  assert.equal(hasDdl.canRestore, false);
  assert.equal(hasDdl.reason, "contains-ddl");

  // Mid-sync incomplete batch (e.g. 500 of 3500 rows synced so far) MUST block partial restore!
  const midSyncEntries = mergeTableAuditEntries({
    sharedEntries: Array.from({ length: 500 }, (_, idx) => ({
      clientId: `partial-${idx + 1}`,
      ts: "2026-11-26T08:53:15Z",
      displayName: "黄亚鹏",
      operation: "UPDATE",
      rowIdentity: { ID: String(idx + 1) },
      columnName: "Name",
      oldValue: "Old",
      newValue: "New",
      source: "import",
      status: "committed",
      operationId: "op-syncing-3500",
      operationSize: 3500,
    })),
  });
  const midSyncRevisions = groupAuditRevisions(midSyncEntries);
  assert.equal(midSyncRevisions.length, 1);
  assert.equal(midSyncRevisions[0].isIncomplete, true);
  assert.equal(midSyncRevisions[0].expectedEntryCount, 3500);
  const incompletePlan = buildHistoryRestorePlan({
    columns,
    primaryKeys: ["ID"],
    liveRows,
    revisions: midSyncRevisions,
    targetIndex: 0,
    target: "before",
  });
  assert.equal(incompletePlan.canRestore, false);
  assert.equal(incompletePlan.reason, "incomplete-revision");
});

test("mockAuditHistory preview_history_state_restore and apply_history_state_restore restore rows and record rollback audit", async () => {
  const rows = [{ ID: 1, Name: "New" }, { ID: 2, Name: "Keep" }];
  const logs = [];
  const table = {
    columns: [
      { column_name: "ID", is_primary_key: true },
      { column_name: "Name", is_primary_key: false },
    ],
  };
  let restoredCalls = 0;
  const handle = createMockAuditHistory({
    logs,
    getRows: () => rows,
    getTable: () => table,
    onRestored: () => { restoredCalls += 1; },
  });

  const ops = [{
    kind: "update",
    rowIdentity: { ID: "1" },
    expectedCurrent: { Name: "New" },
    targetValues: { Name: "Old" },
  }];
  const preview = await handle("preview_history_state_restore", {
    connectionId: "demo",
    database: "game_db",
    tableName: "hero",
    targetLabel: "10:00 修改前",
    operations: ops,
  });
  assert.equal(preview.updated, 1);
  assert.equal(preview.total, 1);
  assert.ok(preview.token);

  await assert.rejects(
    handle("apply_history_state_restore", {
      connectionId: "demo",
      database: "game_db",
      tableName: "hero",
      operations: ops,
      token: "stale-token",
    }),
    /重新预览/,
  );

  const msg = await handle("apply_history_state_restore", {
    connectionId: "demo",
    database: "game_db",
    tableName: "hero",
    targetLabel: "10:00 修改前",
    operations: ops,
    token: preview.token,
  });
  assert.match(msg, /已还原到 10:00 修改前/);
  assert.equal(rows[0].Name, "Old");
  assert.equal(restoredCalls, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].source, "rollback");
});

test("TableChangeHistoryView wires anti-jitter scroll, restore modal, and all 3 i18n locales", () => {
  const view = readFileSync(new URL("./components/TableChangeHistoryView.vue", import.meta.url), "utf8");
  const css = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

  assert.match(view, /createDualPaneScrollSync/);
  assert.match(view, /computeHysteresisVirtualWindow/);
  assert.match(view, /@scroll\.passive="onGridScroll\('before', \$event\)"/);
  assert.match(view, /@scroll\.passive="onGridScroll\('after', \$event\)"/);
  assert.match(view, /preview_history_state_restore/);
  assert.match(view, /apply_history_state_restore/);
  assert.match(view, /data-restore-target="before"/);
  assert.match(view, /data-restore-target="after"/);

  assert.match(css, /\.wb-thv-grid-scroller\s*\{[\s\S]*?overscroll-behavior:\s*none;/);
  assert.match(css, /\.wb-thv-grid-scroller\s*\{[\s\S]*?overflow-anchor:\s*none;/);

  const requiredKeys = [
    "tableHistory.restore.toBefore",
    "tableHistory.restore.toAfter",
    "tableHistory.restore.dialogTitle",
    "tableHistory.restore.confirm",
    "tableHistory.restore.safetyNote",
    "tableHistory.restore.reasonMissingIdentity",
  ];
  for (const key of requiredKeys) {
    assert.ok(zhCN[key], `zhCN missing ${key}`);
    assert.ok(zhTW[key], `zhTW missing ${key}`);
    assert.ok(en[key], `en missing ${key}`);
  }
});

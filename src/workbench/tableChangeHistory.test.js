import test from "node:test";
import assert from "node:assert/strict";

import {
  computeInlineDiff,
  detectExternalNewerModification,
  extractEntryChanges,
  filterRevisionItems,
  groupAuditRevisions,
  mergeTableAuditEntries,
} from "./utils/tableChangeHistory.js";
import {
  canReconstructRevision,
  reconstructRevisionFullTable,
  searchFullTableComparisonRows,
  splitSearchHighlight,
} from "./utils/tableHistorySnapshot.js";
import { useTableChangeHistory } from "./composables/useTableChangeHistory.js";

test("computeInlineDiff pinpoints changed whole token inside structured config strings and keeps pure numbers whole", () => {
  const pipeDiff = computeInlineDiff("101#100|102#200|103#50", "101#100|102#350|103#50");
  assert.equal(pipeDiff.before.hasHighlight, true);
  assert.equal(pipeDiff.before.prefix, "101#100|102#");
  assert.equal(pipeDiff.before.changed, "200");
  assert.equal(pipeDiff.before.suffix, "|103#50");
  assert.equal(pipeDiff.after.changed, "350");

  const pureNum = computeInlineDiff("1280", "1450");
  assert.equal(pureNum.before.hasHighlight, false);
  assert.equal(pureNum.after.hasHighlight, false);

  const chineseDiff = computeInlineDiff("每周完成3次公会任务可领奖", "每周完成5次公会任务可领奖");
  assert.equal(chineseDiff.before.hasHighlight, true);
  assert.equal(chineseDiff.before.prefix, "每周完成");
  assert.equal(chineseDiff.before.changed, "3");
  assert.equal(chineseDiff.after.changed, "5");
  assert.equal(chineseDiff.after.suffix, "次公会任务可领奖");

  const nullToEmpty = computeInlineDiff(null, "");
  assert.equal(nullToEmpty.before.isNull, true);
  assert.equal(nullToEmpty.before.text, "NULL");
  assert.equal(nullToEmpty.after.isEmpty, true);
  assert.equal(nullToEmpty.after.isNull, false);

  const shortUnrelated = computeInlineDiff("10", "99");
  assert.equal(shortUnrelated.before.hasHighlight, false);
  assert.equal(shortUnrelated.after.hasHighlight, false);
});

test("extractEntryChanges handles single-cell UPDATE, multi-field JSON UPDATE, INSERT, DELETE, and DDL", () => {
  const single = extractEntryChanges({
    operation: "UPDATE",
    columnName: "Reward",
    oldValue: "100",
    newValue: "200",
    rowIdentity: { ID: 1001 },
  });
  assert.deepEqual(single.rowIdentity, [{ key: "ID", value: "1001" }]);
  assert.equal(single.changes.length, 1);
  assert.equal(single.changes[0].field, "Reward");
  assert.equal(single.changes[0].before.text, "100");
  assert.equal(single.changes[0].after.text, "200");

  const multi = extractEntryChanges({
    operation: "UPDATE",
    columnName: null,
    oldValue: JSON.stringify({ Name: "旧名", Cost: 50, Same: 1 }),
    newValue: JSON.stringify({ Name: "新名", Cost: 80, Same: 1 }),
  });
  assert.deepEqual(multi.changes.map((c) => c.field), ["Name", "Cost"]);

  const inserted = extractEntryChanges({
    operation: "INSERT",
    newValue: JSON.stringify({ ID: 2001, Name: "新任务" }),
  });
  assert.equal(inserted.rowFields.length, 2);
  assert.equal(inserted.rowFields[1].value.text, "新任务");

  const deleted = extractEntryChanges({
    operation: "DELETE",
    oldValue: JSON.stringify({ ID: 99, Name: "废弃任务" }),
  });
  assert.equal(deleted.rowFields.length, 2);
  assert.equal(deleted.rowFields[0].field, "ID");
});

test("mergeTableAuditEntries deduplicates by clientId, enriches local metadata with shared actor, and isolates distinct servers", () => {
  const merged = mergeTableAuditEntries({
    localEntries: [
      {
        id: 10,
        clientId: "cid-self",
        ts: "2026-11-24T02:00:00Z",
        operation: "UPDATE",
        columnName: "Reward",
        oldValue: "100",
        newValue: "120",
        rowIdentity: { ID: 1 },
        status: "committed",
        source: "grid",
        actor: null,
      },
      {
        id: 11,
        clientId: "cid-aborted",
        ts: "2026-11-24T02:05:00Z",
        operation: "UPDATE",
        status: "aborted",
      },
    ],
    sharedEntries: [
      {
        clientId: "cid-self",
        ts: "2026-11-24T02:00:00Z",
        username: "liusong",
        displayName: "刘岳松",
        operation: "UPDATE",
        columnName: "Reward",
        oldValue: "100",
        newValue: "120",
        status: "committed",
        source: "grid",
        serverKey: null,
      },
      {
        clientId: "cid-teammate",
        ts: "2026-11-24T02:10:00Z",
        username: "ysc",
        displayName: "杨奭宸",
        operation: "UPDATE",
        columnName: "Desc",
        oldValue: "旧描述",
        newValue: "新描述",
        status: "committed",
        source: "grid",
        serverKey: "mysql://192.168.1.243:8306",
      },
      {
        clientId: "cid-other-server",
        ts: "2026-11-24T02:20:00Z",
        username: "other",
        displayName: "其他服",
        operation: "UPDATE",
        status: "committed",
        source: "grid",
        serverKey: "mysql://192.168.1.223:8306",
      },
    ],
    selfLabel: "我",
    serverKey: "mysql://192.168.1.243:8306",
  });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].clientId, "cid-teammate");
  assert.equal(merged[0].actor, "杨奭宸");
  assert.equal(merged[1].clientId, "cid-self");
  assert.equal(merged[1].actor, "刘岳松");
  assert.deepEqual(merged[1].rowIdentity, { ID: 1 });
  assert.equal(merged[1].origin, "merged");
});

test("groupAuditRevisions groups same-batch edits while keeping distinct editors or times separate", () => {
  const entries = mergeTableAuditEntries({
    sharedEntries: [
      {
        clientId: "a1",
        ts: "2026-11-24T02:56:07.500Z",
        displayName: "杨奭宸",
        operation: "UPDATE",
        columnName: "Name",
        oldValue: "A",
        newValue: "B",
        status: "committed",
        source: "import",
      },
      {
        clientId: "a2",
        ts: "2026-11-24T02:56:07.100Z",
        displayName: "杨奭宸",
        operation: "INSERT",
        newValue: JSON.stringify({ ID: 2, Name: "C" }),
        status: "committed",
        source: "import",
      },
      {
        clientId: "b1",
        ts: "2026-11-24T02:56:06.900Z",
        displayName: "杰弟",
        operation: "UPDATE",
        columnName: "Cost",
        oldValue: "10",
        newValue: "20",
        status: "committed",
        source: "grid",
      },
    ],
  });

  const revisions = groupAuditRevisions(entries);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].actor, "杨奭宸");
  assert.equal(revisions[0].entryCount, 2);
  assert.deepEqual(revisions[0].counts, { update: 1, insert: 1, delete: 0, ddl: 0 });
  assert.equal(revisions[1].actor, "杰弟");
  assert.equal(revisions[1].entryCount, 1);
});

test("detectExternalNewerModification flags external DB updates newer than latest audit entry", () => {
  const revisions = groupAuditRevisions(mergeTableAuditEntries({
    sharedEntries: [
      {
        clientId: "c1",
        ts: "2026-11-18T08:20:11Z",
        displayName: "杨奭宸",
        operation: "UPDATE",
        status: "committed",
        source: "grid",
      },
    ],
  }));

  const flagged = detectExternalNewerModification(
    { modifiedAt: "2026-11-20 14:08:29", modifiedSource: "database" },
    revisions,
  );
  assert.equal(flagged?.modifiedAt, "2026-11-20 14:08:29");

  const notFlagged = detectExternalNewerModification(
    { modifiedAt: "2026-11-18 16:20:30", modifiedSource: "shared" },
    revisions,
  );
  assert.equal(notFlagged, null);
});

test("filterRevisionItems filters by field name, Chinese column comment, before/after text, or PK", () => {
  const revisions = groupAuditRevisions(mergeTableAuditEntries({
    localEntries: [
      {
        id: 1,
        clientId: "c1",
        ts: "2026-11-24T02:00:00Z",
        operation: "UPDATE",
        oldValue: JSON.stringify({ Reward: "100", Cost: "50" }),
        newValue: JSON.stringify({ Reward: "300", Cost: "80" }),
        rowIdentity: { ID: 1001 },
        status: "committed",
        source: "grid",
        actor: "刘岳松",
      },
    ],
  }));

  const comments = new Map([["reward", "任务奖励数量"], ["cost", "消耗金币"]]);
  const byComment = filterRevisionItems(revisions[0].items, "奖励", comments);
  assert.equal(byComment.length, 1);
  assert.deepEqual(byComment[0].changes.map((c) => c.field), ["Reward"]);

  const byAfter = filterRevisionItems(revisions[0].items, "80", comments);
  assert.equal(byAfter.length, 1);
  assert.deepEqual(byAfter[0].changes.map((c) => c.field), ["Cost"]);
});

test("useTableChangeHistory loads local + shared history and live full-table snapshot in parallel and closes session", async () => {
  const calls = [];
  const history = useTableChangeHistory({
    isLoggedIn: () => true,
    invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "list_audit_logs") {
        return Promise.resolve([
          {
            id: 1,
            clientId: "cid-1",
            ts: "2026-11-24T02:00:00Z",
            operation: "UPDATE",
            columnName: "Reward",
            oldValue: "10",
            newValue: "20",
            rowIdentity: { ID: "7" },
            status: "committed",
            source: "grid",
            actor: "刘岳松",
          },
        ]);
      }
      if (command === "list_shared_audit_logs") {
        return Promise.resolve([
          {
            clientId: "cid-2",
            ts: "2026-11-24T03:00:00Z",
            username: "ysc",
            displayName: "杨奭宸",
            operation: "UPDATE",
            columnName: "Title",
            oldValue: "旧标题",
            newValue: "新标题",
            rowIdentity: { ID: "7" },
            status: "committed",
            source: "grid",
          },
        ]);
      }
      if (command === "open_table_session") {
        return Promise.resolve({
          sessionId: "sess-history-1",
          primaryKeys: ["ID"],
          columns: [
            { columnName: "ID", columnComment: "编号", isPrimaryKey: true },
            { columnName: "Title", columnComment: "标题", isPrimaryKey: false },
            { columnName: "Reward", columnComment: "奖励", isPrimaryKey: false },
          ],
          rows: [
            { ID: "6", Title: "未改行", Reward: "5" },
            { ID: "7", Title: "新标题", Reward: "20" },
          ],
          nullCells: [[], []],
          hasMore: false,
        });
      }
      if (command === "close_table_session") {
        return Promise.resolve(true);
      }
      return Promise.resolve([]);
    },
  });

  await history.loadForTable({
    connectionId: "mysql-2",
    database: "newsg_4cfg",
    tableName: "uniontaskprop",
    tableComment: "G-公会任务配置",
  });

  assert.equal(history.state.sharedStatus, "loaded");
  assert.equal(history.state.revisions.length, 2);
  assert.equal(history.selectedRevision.value?.actor, "杨奭宸");
  assert.equal(history.actors.value.length, 2);
  // Default view is full table!
  assert.equal(history.state.displayScope, "full");
  assert.equal(history.snapshot.value.mode, "full-table");
  assert.equal(history.displayRows.value.length, 2);
  assert.equal(history.snapshot.value.changedCount, 1);
  assert.equal(history.displayRows.value[1].before.Title, "旧标题");
  assert.equal(history.displayRows.value[1].after.Title, "新标题");

  // Live session was cleanly closed after snapshot load
  const closeCall = calls.find((c) => c.command === "close_table_session");
  assert.equal(closeCall?.payload?.sessionId, "sess-history-1");

  // Search works across full table
  history.setSearchQuery("旧标题");
  assert.equal(history.searchResult.value.matches.length, 1);
  assert.equal(history.activeSearchMatch.value?.colName, "Title");

  // Switching scope to changed-only narrows rows cleanly
  history.setDisplayScope("changed");
  assert.equal(history.displayRows.value.length, 1);

  // Verify shared query omits connectionId so cross-PC histories match
  const sharedCall = calls.find((c) => c.command === "list_shared_audit_logs");
  assert.equal(sharedCall.payload.request.connectionId, undefined);
  assert.equal(sharedCall.payload.request.database, "newsg_4cfg");
  assert.equal(sharedCall.payload.request.tableName, "uniontaskprop");

  // Actor filter narrows revisions and still inverse-replays against ALL revisions!
  history.setDisplayScope("full");
  history.setActorFilter("刘岳松");
  assert.equal(history.filteredRevisions.value.length, 1);
  assert.equal(history.selectedRevision.value?.actor, "刘岳松");
  // When viewing 刘岳松's earlier revision (ID=7 Reward 10->20), Title must be rewound to "旧标题"!
  assert.equal(history.displayRows.value[1].before.Title, "旧标题");
  assert.equal(history.displayRows.value[1].after.Title, "旧标题");
  assert.equal(history.displayRows.value[1].before.Reward, "10");
  assert.equal(history.displayRows.value[1].after.Reward, "20");

  history.setActorFilter("刘岳松"); // toggle off
  assert.equal(history.filteredRevisions.value.length, 2);
});

test("reconstructRevisionFullTable inverse-replays multi-step UPDATE, INSERT, and DELETE revisions accurately", () => {
  const columns = [
    { columnName: "ID", columnComment: "编号", isPrimaryKey: true },
    { columnName: "Name", columnComment: "名称", isPrimaryKey: false },
    { columnName: "Reward", columnComment: "奖励", isPrimaryKey: false },
  ];
  const primaryKeys = ["ID"];
  // Current live table state AFTER rev0 (newest) and rev1 (older):
  // Originally (before rev1): ID=1 (旧名, 100), ID=2 (保留行, 200), ID=3 (将被删, 300)
  // rev1 (older): UPDATE ID=1 Reward 100->150, DELETE ID=3
  // rev0 (newest): UPDATE ID=1 Reward 150->250 + Name 旧名->新名, INSERT ID=4 (新增行, 400)
  const liveRows = [
    { ID: "1", Name: "新名", Reward: "250" },
    { ID: "2", Name: "保留行", Reward: "200" },
    { ID: "4", Name: "新增行", Reward: "400" },
  ];

  const revisions = groupAuditRevisions(mergeTableAuditEntries({
    sharedEntries: [
      {
        clientId: "r0-1",
        ts: "2026-11-24T04:00:00.500Z",
        displayName: "杨奭宸",
        operation: "UPDATE",
        rowIdentity: { ID: "1" },
        columnName: "Reward",
        oldValue: "150",
        newValue: "250",
        status: "committed",
        source: "grid",
      },
      {
        clientId: "r0-2",
        ts: "2026-11-24T04:00:00.200Z",
        displayName: "杨奭宸",
        operation: "UPDATE",
        rowIdentity: { ID: "1" },
        columnName: "Name",
        oldValue: "旧名",
        newValue: "新名",
        status: "committed",
        source: "grid",
      },
      {
        clientId: "r0-3",
        ts: "2026-11-24T04:00:00.100Z",
        displayName: "杨奭宸",
        operation: "INSERT",
        rowIdentity: { ID: "4" },
        newValue: JSON.stringify({ ID: "4", Name: "新增行", Reward: "400" }),
        status: "committed",
        source: "grid",
      },
      {
        clientId: "r1-1",
        ts: "2026-11-24T03:00:00.500Z",
        displayName: "刘岳松",
        operation: "UPDATE",
        rowIdentity: { ID: "1" },
        columnName: "Reward",
        oldValue: "100",
        newValue: "150",
        status: "committed",
        source: "grid",
      },
      {
        clientId: "r1-2",
        ts: "2026-11-24T03:00:00.200Z",
        displayName: "刘岳松",
        operation: "DELETE",
        oldValue: JSON.stringify({ ID: "3", Name: "将被删", Reward: "300" }),
        status: "committed",
        source: "grid",
      },
    ],
  }));

  assert.equal(revisions.length, 2);

  // Inspect rev0 (newest)
  const snap0 = reconstructRevisionFullTable({
    columns,
    primaryKeys,
    liveRows,
    revisions,
    targetIndex: 0,
  });
  assert.equal(snap0.mode, "full-table");
  assert.equal(snap0.totalRows, 3);
  assert.equal(snap0.changedCount, 2);
  assert.deepEqual(snap0.changedRowIndices, [0, 2]);
  assert.equal(snap0.rows[0].status, "updated");
  assert.equal(snap0.rows[0].before.Reward, "150");
  assert.equal(snap0.rows[0].after.Reward, "250");
  assert.equal(snap0.rows[0].before.Name, "旧名");
  assert.equal(snap0.rows[0].after.Name, "新名");
  assert.equal(snap0.rows[1].status, "unchanged");
  assert.equal(snap0.rows[2].status, "inserted");
  assert.equal(snap0.rows[2].before, null);
  assert.equal(snap0.rows[2].after.Name, "新增行");

  // Inspect rev1 (older): ID=4 must NOT appear (inserted later), ID=3 must appear as deleted,
  // and ID=1 must show Reward 100 -> 150 with Name="旧名" on both sides!
  const snap1 = reconstructRevisionFullTable({
    columns,
    primaryKeys,
    liveRows,
    revisions,
    targetIndex: 1,
  });
  assert.equal(snap1.mode, "full-table");
  assert.equal(snap1.totalRows, 3);
  assert.equal(snap1.changedCount, 2);
  const row1 = snap1.rows.find((r) => r.identity.ID === "1");
  const row2 = snap1.rows.find((r) => r.identity.ID === "2");
  const row3 = snap1.rows.find((r) => r.identity.ID === "3");
  const row4 = snap1.rows.find((r) => r.identity.ID === "4");
  assert.equal(row4, undefined);
  assert.equal(row1.status, "updated");
  assert.equal(row1.before.Reward, "100");
  assert.equal(row1.after.Reward, "150");
  assert.equal(row1.before.Name, "旧名");
  assert.equal(row1.after.Name, "旧名");
  assert.equal(row2.status, "unchanged");
  assert.equal(row3.status, "deleted");
  assert.equal(row3.before.Name, "将被删");
  assert.equal(row3.after, null);
});

test("reconstructRevisionFullTable gracefully falls back to field-diff for legacy teammate UPDATE lacking rowIdentity or no-PK tables", () => {
  const columns = [
    { columnName: "ID", columnComment: "编号", isPrimaryKey: true },
    { columnName: "Title", columnComment: "标题", isPrimaryKey: false },
  ];
  const legacyRevisions = groupAuditRevisions(mergeTableAuditEntries({
    sharedEntries: [
      {
        clientId: "legacy-1",
        ts: "2026-11-24T03:00:00Z",
        displayName: "杨奭宸",
        operation: "UPDATE",
        columnName: "Title",
        oldValue: "旧标题",
        newValue: "新标题",
        status: "committed",
        source: "grid",
      },
    ],
  }));

  assert.deepEqual(
    canReconstructRevision(legacyRevisions[0], ["ID"], columns),
    { ok: false, reason: "missing-row-identity" },
  );
  const fallback = reconstructRevisionFullTable({
    columns,
    primaryKeys: ["ID"],
    liveRows: [{ ID: "1", Title: "新标题" }],
    revisions: legacyRevisions,
    targetIndex: 0,
  });
  assert.equal(fallback.mode, "field-diff");
  assert.equal(fallback.reason, "missing-row-identity");

  const noPk = canReconstructRevision(legacyRevisions[0], [], columns);
  assert.deepEqual(noPk, { ok: false, reason: "no-primary-key" });
});

test("searchFullTableComparisonRows matches cell values, PKs, and Chinese column comments cleanly", () => {
  const columns = [
    { name: "ID", comment: "编号", primaryKey: true },
    { name: "Reward", comment: "公会奖励", primaryKey: false },
  ];
  const rows = [
    {
      id: '[["ID","1001"]]',
      rowIndex: 0,
      identity: { ID: "1001" },
      status: "updated",
      before: { ID: "1001", Reward: "102#200" },
      after: { ID: "1001", Reward: "102#350" },
      changedCols: ["Reward"],
      cellDiffs: {},
    },
    {
      id: '[["ID","1002"]]',
      rowIndex: 1,
      identity: { ID: "1002" },
      status: "unchanged",
      before: { ID: "1002", Reward: "101#100" },
      after: { ID: "1002", Reward: "101#100" },
      changedCols: [],
      cellDiffs: {},
    },
  ];

  const byValue = searchFullTableComparisonRows(rows, columns, "350");
  assert.equal(byValue.matches.length, 1);
  assert.equal(byValue.matches[0].colName, "Reward");
  assert.equal(byValue.matches[0].displayIndex, 0);

  const byComment = searchFullTableComparisonRows(rows, columns, "公会奖励");
  assert.ok(byComment.matchedHeaderCols.has("Reward"));
  assert.equal(byComment.matches.length, 1);
  assert.equal(byComment.matches[0].rowId, rows[0].id);

  const segments = splitSearchHighlight("102#350|103#350", "350");
  assert.deepEqual(segments, [
    { text: "102#", match: false },
    { text: "350", match: true },
    { text: "|103#", match: false },
    { text: "350", match: true },
  ]);
});

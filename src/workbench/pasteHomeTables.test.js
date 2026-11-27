import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHomeTablePasteCoordinator } from "./homeTablePasteCoordinator.js";

const source = readFileSync(new URL("./MySqlWorkbench.vue", import.meta.url), "utf8");
const handler = source.slice(
  source.indexOf("function copiedHomeTableNames("),
  source.indexOf("async function renameHomeTable("),
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness({
  invoke,
  loadTables,
  tables = ["t1", "t2", "t3", "t4"],
  targetConnectionId = "conn-1",
  targetDatabase = "target_db",
  committedSource = { connectionId: targetConnectionId, database: targetDatabase },
} = {}) {
  const listeners = new Map();
  const reminders = [];
  const home = { selectedTableNames: [], focusedTableName: "" };
  let committed = { ...committedSource };
  const state = {
    busy: { value: false },
    statusText: { value: "" },
    selectedConnectionId: { value: targetConnectionId },
    selectedDatabase: { value: targetDatabase },
    homeTableClipboard: {
      value: {
        type: "dbscout.tableObjects",
        connectionId: "conn-src",
        database: "src_db",
        tables,
      },
    },
    pasteTablesProgress: { value: null },
    nextPasteOperationId: 1,
    pendingPasteTotal: 0,
    homeTablePasteCoordinator: null,
    isReadOnlyConnection: () => false,
    connectionCapability: () => true,
    blockReadOnlyAction() {},
    blockUnsupportedEngine() {},
    invokeWorkbench: invoke || (async (_command, { request }) => ({
      status: "succeeded",
      copied: request.tableNames.map((name) => ({ originalName: name, targetName: name, rowCount: 1 })),
      warnings: [],
    })),
    listenWorkbenchEvent: async (eventName, cb) => {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(cb);
      return () => listeners.get(eventName)?.delete(cb);
    },
    loadTables: loadTables || (async () => {}),
    openCurrentDatabaseHome: () => home,
    showWorkbenchReminder: (kind, message) => reminders.push({ kind, message }),
  };

  state.homeTablePasteCoordinator = createHomeTablePasteCoordinator({
    getCommittedSource: () => committed,
    onWaitForNavigation: ({ database }) => {
      state.statusText.value = `正在切换到 ${database}，完成后继续粘贴…`;
      if (state.pendingPasteTotal > 0) {
        state.pasteTablesProgress.value = {
          database,
          done: 0,
          total: state.pendingPasteTotal,
          copied: 0,
          currentTable: "",
          phase: "switching",
        };
      }
    },
  });

  const emitProgress = (payload) => {
    for (const cb of listeners.get("table-copy-progress") || []) {
      cb({ payload });
    }
  };

  const run = runInNewContext(`${handler}; pasteHomeTables`, state);
  return {
    state,
    home,
    reminders,
    emitProgress,
    setCommittedSource: (next) => { committed = { ...next }; },
    run: (opts = {}) => run({
      target: { connectionId: targetConnectionId, database: targetDatabase },
      ...opts,
    }),
  };
}

test("multi-table paste publishes live progress, ignores other operationIds, refreshes, and summarizes >3 names", async () => {
  const snapshots = [];
  let capturedOperationId = "";
  let h;
  h = harness({
    tables: ["t1", "t2", "t3", "t4"],
    invoke: async (_command, { request }) => {
      capturedOperationId = request.operationId;
      snapshots.push({ ...h.state.pasteTablesProgress.value });
      h.emitProgress({
        operationId: "other-op",
        done: 99,
        total: 99,
        copied: 99,
        currentTable: "wrong_table",
      });
      h.emitProgress({
        operationId: capturedOperationId,
        done: 1,
        total: 4,
        copied: 1,
        currentTable: "t1",
      });
      snapshots.push({ ...h.state.pasteTablesProgress.value });
      assert.match(h.state.statusText.value, /1\/4/);
      h.emitProgress({
        operationId: capturedOperationId,
        done: 4,
        total: 4,
        copied: 4,
        currentTable: "t4",
      });
      snapshots.push({ ...h.state.pasteTablesProgress.value });
      return {
        status: "succeeded",
        copied: request.tableNames.map((name) => ({ originalName: name, targetName: name, rowCount: 0 })),
        warnings: [],
      };
    },
    loadTables: async () => {
      snapshots.push({ ...h.state.pasteTablesProgress.value });
    },
  });

  let successNames = null;
  await h.run({ onSuccess: (names) => { successNames = names; } });

  assert.ok(capturedOperationId);
  assert.deepEqual(
    snapshots.map((item) => [item.phase, item.done, item.total, item.copied, item.currentTable]),
    [
      ["pasting", 0, 4, 0, "t1"],
      ["pasting", 1, 4, 1, "t1"],
      ["pasting", 4, 4, 4, "t4"],
      ["refreshing", 4, 4, 4, ""],
    ],
  );
  assert.equal(h.state.pasteTablesProgress.value, null);
  assert.equal(h.state.busy.value, false);
  assert.deepEqual([...successNames], ["t1", "t2", "t3", "t4"]);
  assert.equal(h.state.statusText.value, "已粘贴 4 张表：t1、t2、t3 等");
  assert.deepEqual(h.reminders, [{ kind: "success", message: "已粘贴 4 张表" }]);
});

test("waiting for database navigation shows switching phase and clears when navigation fails; paste-pending keeps active progress", async () => {
  const nav = deferred();
  const h = harness({
    tables: ["t1", "t2"],
    committedSource: { connectionId: "conn-1", database: "other_db" },
  });
  h.state.homeTablePasteCoordinator.trackNavigation(
    { connectionId: "conn-1", database: "target_db" },
    nav.promise,
  );

  const first = h.run();
  await Promise.resolve();
  assert.deepEqual(h.state.pasteTablesProgress.value, {
    database: "target_db",
    done: 0,
    total: 2,
    copied: 0,
    currentTable: "",
    phase: "switching",
  });

  // Concurrent paste attempt while switching/pasting must not clear active progress.
  await h.run();
  assert.equal(h.state.statusText.value, "正在粘贴表，请勿重复操作");
  assert.equal(h.state.pasteTablesProgress.value?.phase, "switching");

  nav.resolve(false);
  await first;
  assert.equal(h.state.pasteTablesProgress.value, null);
  assert.equal(h.state.statusText.value, "目标数据库切换失败，未执行粘贴");

  // target-not-ready also leaves progress cleared.
  await h.run();
  assert.equal(h.state.pasteTablesProgress.value, null);
  assert.equal(h.state.statusText.value, "目标数据库尚未就绪，未执行粘贴");
});

test("partial paste failure best-effort refreshes created tables and clears progress and busy state", async () => {
  let refreshes = 0;
  let h;
  h = harness({
    tables: ["t1", "t2", "t3"],
    invoke: async (_command, { request }) => {
      h.emitProgress({
        operationId: request.operationId,
        done: 2,
        total: 3,
        copied: 2,
        currentTable: "t2",
      });
      throw new Error("disk full");
    },
    loadTables: async () => {
      refreshes += 1;
    },
  });

  await h.run();
  assert.equal(refreshes, 1);
  assert.equal(h.state.pasteTablesProgress.value, null);
  assert.equal(h.state.busy.value, false);
  assert.match(h.state.statusText.value, /粘贴表失败：disk full/);
});

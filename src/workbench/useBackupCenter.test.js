import test from "node:test";
import assert from "node:assert/strict";

import { useBackupCenter } from "./composables/useBackupCenter.js";

// Minimal in-memory command/event backend stubbing the 8 backup commands.
function createBackend() {
  const listeners = new Map();
  let nextId = 100;
  const logs = [
    {
      id: 1,
      ts: "2026-06-20T09:00:00Z",
      connectionId: "demo",
      database: "game_db",
      tableName: "player",
      operation: "UPDATE",
      columnName: "level",
      oldValue: "12",
      newValue: "99",
      forwardSql: "UPDATE `player` SET `level`=? WHERE `id` <=> ? AND `level`=? LIMIT 1",
      inverseSql: "UPDATE `player` SET `level`=? WHERE `id` <=> ? AND `level`=? LIMIT 1",
      rollbackStrategy: "auto",
      source: "grid",
      status: "committed",
      isRollback: false,
      rollbackOf: null,
    },
  ];

  return {
    listeners,
    invokeWorkbench(command, payload = {}) {
      if (command === "list_audit_logs") {
        return Promise.resolve(logs.slice());
      }
      if (command === "list_snapshots") {
        return Promise.resolve([
          { path: "/tmp/s1.sql", connectionId: "demo", database: "game_db", ts: "20260620-090000", sizeBytes: 1024, tableCount: 5, manifest: null },
        ]);
      }
      if (command === "get_backup_config") {
        return Promise.resolve({
          enabled: true,
          intervalMinutes: 30,
          largeTableThreshold: 50000,
          maxPerDb: 50,
          databasesScope: "all",
          auditRetentionDays: 90,
        });
      }
      if (command === "set_backup_config") {
        return Promise.resolve(payload.config);
      }
      if (command === "create_snapshot") {
        return Promise.resolve({
          path: "/tmp/s2.sql", connectionId: "demo", database: "game_db", ts: "20260620-100000", sizeBytes: 2048, tableCount: 5, manifest: null,
        });
      }
      if (command === "restore_snapshot") {
        return Promise.resolve({ preRestoreSnapshotPath: "/tmp/pre.sql", database: "game_db" });
      }
      if (command === "prune_snapshots") {
        return Promise.resolve({ deletedCount: 0 });
      }
      if (command === "rollback_audit_entry") {
        const id = payload.request?.auditId;
        const entry = logs.find((item) => item.id === id);
        if (!entry || entry.status !== "committed" || entry.isRollback) {
          return Promise.resolve({ rolledBack: false, newAuditId: null, conflict: true, message: "无法回滚" });
        }
        entry.status = "rolled_back";
        const newId = nextId++;
        logs.unshift({
          ...entry,
          id: newId,
          operation: entry.operation === "INSERT" ? "DELETE" : entry.operation === "DELETE" ? "INSERT" : "UPDATE",
          forwardSql: entry.inverseSql,
          inverseSql: entry.forwardSql,
          source: "rollback",
          isRollback: true,
          rollbackOf: entry.id,
        });
        for (const handler of listeners.get("backup-job") || []) {
          handler({ payload: { kind: "rollback", database: entry.database, table: entry.tableName } });
        }
        return Promise.resolve({ rolledBack: true, newAuditId: newId, conflict: false, message: "已回滚" });
      }
      return Promise.resolve(null);
    },
    listen(eventName, handler) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(handler);
      return () => listeners.get(eventName)?.delete(handler);
    },
  };
}

test("open loads audit logs, snapshots and config", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.auditLogs.value.length, 1);
  assert.equal(backup.auditLogs.value[0].id, 1);
  assert.equal(backup.snapshots.value.length, 1);
  assert.equal(backup.config.value.intervalMinutes, 30);
  assert.equal(backup.dialog.open, true);
  backup.dispose();
});

test("rollback marks the original entry rolled back and records a symmetric rollback row", async () => {
  let dataChanged = 0;
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend, onDataChanged: () => { dataChanged += 1; } });
  await backup.open();
  const result = await backup.rollback(1);
  assert.equal(result.rolledBack, true);
  assert.equal(result.conflict, false);
  assert.ok(result.newAuditId);
  // reload reflects the rolled-back original + the new rollback row
  await backup.loadAuditLogs();
  const original = backup.auditLogs.value.find((item) => item.id === 1);
  assert.equal(original.status, "rolled_back");
  const rollbackRow = backup.auditLogs.value.find((item) => item.id === result.newAuditId);
  assert.ok(rollbackRow);
  assert.equal(rollbackRow.isRollback, true);
  assert.equal(rollbackRow.rollbackOf, 1);
  assert.equal(dataChanged, 1);
  backup.dispose();
});

test("rolling back a non-committable entry returns conflict without side effects", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  // id 999 does not exist
  const result = await backup.rollback(999);
  assert.equal(result.rolledBack, false);
  assert.equal(result.conflict, true);
  backup.dispose();
});

test("createSnapshot refreshes the snapshot list", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.snapshots.value.length, 1);
  await backup.createSnapshot({ connectionId: "demo", database: "game_db" });
  assert.equal(backup.snapshots.value.length, 1);
  backup.dispose();
});

test("snapshot-progress 'done' event triggers a snapshot reload", async () => {
  let snapshotCalls = 0;
  const backend = createBackend();
  backend.invokeWorkbench = (command, payload = {}) => {
    if (command === "list_snapshots") {
      snapshotCalls += 1;
      return Promise.resolve([
        { path: `/tmp/s${snapshotCalls}.sql`, connectionId: "demo", database: "game_db", ts: `20260620-09000${snapshotCalls}`, sizeBytes: 1024, tableCount: 5, manifest: null },
      ]);
    }
    return createBackend().invokeWorkbench(command, payload);
  };
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.snapshots.value[0].path, "/tmp/s1.sql");
  // simulate a progress 'done' event through the listener registered on open()
  const handlers = backend.listeners.get("snapshot-progress");
  assert.ok(handlers && handlers.size > 0);
  for (const handler of handlers) {
    handler({ payload: { status: "done", done: 3, total: 3, jobId: "j1", connectionId: "demo", database: "game_db" } });
  }
  // listener reload is async; flush microtasks
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(snapshotCalls >= 2, "snapshot list should be reloaded after 'done' event");
  assert.equal(backup.snapshots.value[0].path, "/tmp/s2.sql");
  backup.dispose();
});

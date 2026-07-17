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

  const deletedPaths = [];
  const openedPaths = [];
  const savedConfigs = [];
  const setSnapshotEnabledCalls = [];
  const importSnapshotCalls = [];
  let listSnapshotCalls = 0;
  let inspectionResult = {
    sourcePath: "/external/20260618-073000.sql",
    fileName: "20260618-073000.sql",
    sizeBytes: 4096,
    originConnectionId: "demo",
    originDatabase: "game_db",
    originTs: "20260618-073000",
  };
  let pickedDir = null;
  let lastAuditRequest = null;
  let lastSharedAuditRequest = null;
  const sharedLogs = [
    {
      clientId: "shared-1",
      ts: "2026-06-24T08:00:00Z",
      userId: "u-other",
      username: "frank",
      displayName: "Frank",
      connectionId: "demo",
      database: "game_db",
      tableName: "hero",
      operation: "UPDATE",
      columnName: "level",
      oldValue: "5",
      newValue: "6",
      source: "grid",
      status: "committed",
      isRollback: false,
    },
  ];
  // In-memory per-database snapshot opt-in whitelist, mirroring the backend.
  let snapshotEnabledDatabases = [];
  let databasesScope = "selected";

  return {
    listeners,
    get deletedPaths() { return deletedPaths; },
    get openedPaths() { return openedPaths; },
    get savedConfigs() { return savedConfigs; },
    get pickedDir() { return pickedDir; },
    setPickedDir(value) { pickedDir = value; },
    get snapshotEnabledDatabases() { return snapshotEnabledDatabases.slice(); },
    get setSnapshotEnabledCalls() { return setSnapshotEnabledCalls; },
    get importSnapshotCalls() { return importSnapshotCalls.slice(); },
    get listSnapshotCalls() { return listSnapshotCalls; },
    setInspection(value) { inspectionResult = value; },
    setSnapshotScope(scope) { databasesScope = scope; },
    setSnapshotEnabledDatabases(list) { snapshotEnabledDatabases = (list || []).slice(); },
    get lastAuditRequest() { return lastAuditRequest; },
    get lastSharedAuditRequest() { return lastSharedAuditRequest; },
    invokeWorkbench(command, payload = {}) {
      if (command === "list_audit_logs") {
        lastAuditRequest = payload.request || {};
        return Promise.resolve(logs.slice());
      }
      if (command === "list_shared_audit_logs") {
        lastSharedAuditRequest = payload.request || {};
        return Promise.resolve(sharedLogs.slice());
      }
      if (command === "clear_audit_logs") {
        const deletedCount = logs.length;
        logs.length = 0;
        return Promise.resolve(deletedCount);
      }
      if (command === "list_snapshots") {
        listSnapshotCalls += 1;
        return Promise.resolve([
          { path: "/tmp/s1.sql", connectionId: "demo", database: "game_db", ts: "20260620-090000", sizeBytes: 1024, tableCount: 5, manifest: null, location: "current" },
        ]);
      }
      if (command === "get_backup_config") {
        return Promise.resolve({
          enabled: true,
          intervalMinutes: 30,
          largeTableThreshold: 50000,
          maxPerDb: 50,
          databasesScope,
          snapshotEnabledDatabases: snapshotEnabledDatabases.slice(),
          auditRetentionDays: 90,
          storageDir: null,
          resolvedStorageDir: "/tmp/dbscout-backup",
        });
      }
      if (command === "set_backup_config") {
        savedConfigs.push(payload.config);
        return Promise.resolve(payload.config);
      }
      if (command === "set_snapshot_enabled") {
        const req = payload.request || {};
        setSnapshotEnabledCalls.push(req);
        // Transition "all" -> "selected": seed the whitelist with the demo
        // connection's databases first (matches backend behavior).
        if (databasesScope === "all") {
          snapshotEnabledDatabases = [
            { connectionId: "demo", database: "game_db" },
            { connectionId: "demo", database: "analytics" },
          ];
          databasesScope = "selected";
        }
        const key = { connectionId: req.connectionId, database: req.database };
        const exists = snapshotEnabledDatabases.some(
          (item) => item.connectionId === key.connectionId && item.database === key.database,
        );
        if (req.enabled && !exists) {
          snapshotEnabledDatabases.push(key);
        } else if (!req.enabled && exists) {
          snapshotEnabledDatabases = snapshotEnabledDatabases.filter(
            (item) => !(item.connectionId === key.connectionId && item.database === key.database),
          );
        }
        return Promise.resolve({
          enabled: true,
          intervalMinutes: 30,
          largeTableThreshold: 50000,
          maxPerDb: 50,
          databasesScope,
          snapshotEnabledDatabases: snapshotEnabledDatabases.slice(),
          auditRetentionDays: 90,
          storageDir: null,
          resolvedStorageDir: "/tmp/dbscout-backup",
        });
      }
      if (command === "create_snapshot") {
        return Promise.resolve({
          path: "/tmp/s2.sql", connectionId: "demo", database: "game_db", ts: "20260620-100000", sizeBytes: 2048, tableCount: 5, manifest: null, location: "current",
        });
      }
      if (command === "restore_snapshot") {
        return Promise.resolve({ preRestoreSnapshotPath: "/tmp/pre.sql", database: "game_db" });
      }
      if (command === "inspect_snapshot_file") {
        return Promise.resolve(inspectionResult);
      }
      if (command === "import_snapshot") {
        const req = payload.request || {};
        importSnapshotCalls.push(req);
        return Promise.resolve({
          path: "/tmp/imported.sql", connectionId: req.connectionId, database: req.database, ts: "20260618-073000", sizeBytes: 4096, tableCount: 0, manifest: null, location: "current",
        });
      }
      if (command === "prune_snapshots") {
        return Promise.resolve({ deletedCount: 0 });
      }
      if (command === "delete_snapshot") {
        deletedPaths.push(payload.snapshotPath);
        return Promise.resolve();
      }
      if (command === "pick_backup_directory") {
        return Promise.resolve(pickedDir);
      }
      if (command === "open_backup_path") {
        openedPaths.push(payload.path);
        return Promise.resolve();
      }
      if (command === "list_databases") {
        return Promise.resolve(payload.connectionId === "demo" ? ["game_db", "analytics"] : ["other_db"]);
      }
      if (command === "list_tables") {
        return Promise.resolve([
          { table_name: "player" },
          { table_name: "hero" },
        ]);
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

test("open loads filter dropdown options for the selected connection and database", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  backup.setFilters({ connectionId: "demo", database: "game_db" });
  await backup.open();
  assert.deepEqual(backup.filterDatabases.value, ["game_db", "analytics"]);
  assert.deepEqual(backup.filterTables.value, ["player", "hero"]);
  backup.dispose();
});

test("connection filter change reloads database and table dropdown options", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  backup.setFilters({ connectionId: "demo", database: "game_db", tableName: "player" });
  await backup.loadFilterOptions();
  assert.deepEqual(backup.filterDatabases.value, ["game_db", "analytics"]);
  assert.deepEqual(backup.filterTables.value, ["player", "hero"]);
  backup.setFilters({ connectionId: "other", database: "", tableName: "" });
  await backup.loadFilterOptions();
  assert.deepEqual(backup.filterDatabases.value, ["other_db"]);
  assert.deepEqual(backup.filterTables.value, []);
  backup.dispose();
});

test("open loads audit logs, snapshots and config and lands on the audit tab", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  backup.dialog.tab = "snapshot";
  await backup.open();
  assert.equal(backup.auditLogs.value.length, 1);
  assert.equal(backup.auditLogs.value[0].id, 1);
  assert.equal(backup.snapshots.value.length, 1);
  assert.equal(backup.config.value.intervalMinutes, 30);
  assert.equal(backup.config.value.resolvedStorageDir, "/tmp/dbscout-backup");
  assert.equal(backup.dialog.open, true);
  assert.equal(backup.dialog.tab, "audit");
  backup.dispose();
});

test("clearAuditLogs deletes all audit records and refreshes the list", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.auditLogs.value.length, 1);
  const result = await backup.clearAuditLogs();
  assert.equal(result.deletedCount, 1);
  assert.equal(backup.auditLogs.value.length, 0);
  backup.dispose();
});

test("openBackupPath opens the requested backup path through the backend", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });

  assert.equal(await backup.openBackupPath("/tmp/dbscout-backup/snapshots/demo/game_db/s1.sql"), true);
  assert.deepEqual(backend.openedPaths, ["/tmp/dbscout-backup/snapshots/demo/game_db/s1.sql"]);
  assert.equal(backup.lastError.value, "");
  backup.dispose();
});

test("openBackupPath reports backend failures without throwing", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({
    ...backend,
    invokeWorkbench: (command, payload = {}) => {
      if (command === "open_backup_path") {
        return Promise.reject(new Error("path is outside backup storage"));
      }
      return backend.invokeWorkbench(command, payload);
    },
  });

  assert.equal(await backup.openBackupPath("/evil.sql"), false);
  assert.equal(backup.lastError.value, "path is outside backup storage");
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

test("snapshot operations use the active connection and database filters", async () => {
  const calls = [];
  const backend = createBackend();
  const baseInvoke = backend.invokeWorkbench;
  backend.invokeWorkbench = (command, payload = {}) => {
    if (["create_snapshot", "prune_snapshots", "list_snapshots"].includes(command)) {
      calls.push({ command, payload });
    }
    return baseInvoke(command, payload);
  };

  const backup = useBackupCenter({ ...backend });
  backup.setFilters({ connectionId: "demo", database: "game_db" });
  await backup.open();
  await backup.createSnapshotFromFilters();
  await backup.pruneSnapshots();

  assert.deepEqual(
    calls.find((call) => call.command === "create_snapshot")?.payload,
    { request: { connectionId: "demo", database: "game_db" } },
  );
  assert.deepEqual(
    calls.find((call) => call.command === "prune_snapshots")?.payload,
    { request: { connectionId: "demo", database: "game_db" } },
  );
  assert.ok(
    calls.some((call) => (
      call.command === "list_snapshots" &&
      call.payload?.request?.connectionId === "demo" &&
      call.payload?.request?.database === "game_db"
    )),
    "snapshot list should be filtered by the active snapshot restore filters",
  );
  backup.dispose();
});

test("snapshot-progress 'done' event triggers a snapshot reload", async () => {
  let snapshotCalls = 0;
  const backend = createBackend();
  backend.invokeWorkbench = (command, payload = {}) => {
    if (command === "list_snapshots") {
      snapshotCalls += 1;
      return Promise.resolve([
        { path: `/tmp/s${snapshotCalls}.sql`, connectionId: "demo", database: "game_db", ts: `20260620-09000${snapshotCalls}`, sizeBytes: 1024, tableCount: 5, manifest: null, location: "current" },
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

test("manual refresh helpers report success and failure to the dialog", async () => {
  const backend = createBackend();
  let invoke = backend.invokeWorkbench;
  const backup = useBackupCenter({
    ...backend,
    invokeWorkbench: (command, payload) => invoke(command, payload),
  });
  await backup.open();

  assert.equal(await backup.loadAuditLogs(), true);
  assert.equal(await backup.loadSnapshots(), true);

  invoke = (command, payload = {}) => {
    if (command === "list_audit_logs") {
      return Promise.reject(new Error("audit unavailable"));
    }
    return createBackend().invokeWorkbench(command, payload);
  };

  assert.equal(await backup.loadAuditLogs(), false);
  assert.equal(backup.lastError.value, "audit unavailable");
  backup.dispose();
});

test("saveConfig reports whether settings were saved", async () => {
  const backend = createBackend();
  let invoke = backend.invokeWorkbench;
  const backup = useBackupCenter({
    ...backend,
    invokeWorkbench: (command, payload) => invoke(command, payload),
  });

  assert.equal(await backup.saveConfig({ intervalMinutes: 45 }), true);
  assert.equal(backup.config.value.intervalMinutes, 45);

  invoke = (command, payload = {}) => {
    if (command === "set_backup_config") {
      return Promise.reject(new Error("config write failed"));
    }
    return createBackend().invokeWorkbench(command, payload);
  };

  assert.equal(await backup.saveConfig({ intervalMinutes: 60 }), false);
  assert.equal(backup.lastError.value, "config write failed");
  backup.dispose();
});

test("saveConfig preserves the user-selected backup storage directory", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });

  await backup.open();
  const selectedDir = "E:/dbscout-backups";
  backup.config.value = { ...backup.config.value, storageDir: selectedDir, resolvedStorageDir: selectedDir };

  assert.equal(await backup.saveConfig({ ...backup.config.value }), true);
  assert.equal(backend.savedConfigs.at(-1)?.storageDir, selectedDir);
  assert.equal(backup.config.value.storageDir, selectedDir);
  assert.equal(backup.config.value.resolvedStorageDir, selectedDir);
  backup.dispose();
});

test("pruneSnapshots reports deleted snapshots and refreshes the list", async () => {
  let snapshotCalls = 0;
  const backend = createBackend();
  const baseInvoke = backend.invokeWorkbench;
  backend.invokeWorkbench = (command, payload = {}) => {
    if (command === "list_snapshots") {
      snapshotCalls += 1;
      return Promise.resolve(
        snapshotCalls === 1
          ? [
              { path: "/tmp/s1.sql", connectionId: "demo", database: "game_db", ts: "20260620-090000", sizeBytes: 1024, tableCount: 5, manifest: null, location: "current" },
              { path: "/tmp/s2.sql", connectionId: "demo", database: "game_db", ts: "20260620-100000", sizeBytes: 2048, tableCount: 5, manifest: null, location: "current" },
            ]
          : [
              { path: "/tmp/s2.sql", connectionId: "demo", database: "game_db", ts: "20260620-100000", sizeBytes: 2048, tableCount: 5, manifest: null, location: "current" },
            ],
      );
    }
    if (command === "prune_snapshots") {
      return Promise.resolve({ deletedCount: 1 });
    }
    return baseInvoke(command, payload);
  };

  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.snapshots.value.length, 2);

  const result = await backup.pruneSnapshots();
  assert.equal(result.deletedCount, 1);
  assert.equal(backup.snapshots.value.length, 1);
  assert.ok(snapshotCalls >= 2);
  backup.dispose();
});

test("deleteSnapshot 调用 delete_snapshot 命令并刷新列表", async () => {
  const backend = createBackend();
  const { deleteSnapshot, snapshots } = useBackupCenter({
    invokeWorkbench: backend.invokeWorkbench,
    listen: backend.listen,
  });
  await deleteSnapshot("/tmp/s1.sql");
  assert.deepEqual(backend.deletedPaths, ["/tmp/s1.sql"]);
  // loadSnapshots 被调用，snapshots 仍为数组
  assert.ok(Array.isArray(snapshots.value));
});

test("deleteSnapshot 失败时抛错并记 lastError", async () => {
  const backend = createBackend();
  const failing = (command, payload) => {
    if (command === "delete_snapshot") return Promise.reject(new Error("路径不在允许的快照目录内"));
    return backend.invokeWorkbench(command, payload);
  };
  const { deleteSnapshot, lastError } = useBackupCenter({
    invokeWorkbench: failing,
    listen: backend.listen,
  });
  await assert.rejects(() => deleteSnapshot("/evil.sql"), /路径不在允许/);
  assert.match(lastError.value, /路径不在允许/);
});

test("pickStorageDir 返回后端选中的目录", async () => {
  const backend = createBackend();
  backend.setPickedDir("D:/backups");
  const { pickStorageDir } = useBackupCenter({
    invokeWorkbench: backend.invokeWorkbench,
    listen: backend.listen,
  });
  const dir = await pickStorageDir();
  assert.equal(dir, "D:/backups");
});

test("pickStorageDir 用户取消返回 null", async () => {
  const backend = createBackend();
  backend.setPickedDir(null);
  const { pickStorageDir } = useBackupCenter({
    invokeWorkbench: backend.invokeWorkbench,
    listen: backend.listen,
  });
  const dir = await pickStorageDir();
  assert.equal(dir, null);
});

test("isSnapshotEnabled defaults to selected-scope with an empty whitelist (nothing enabled)", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.config.value.databasesScope, "selected");
  assert.deepEqual(backup.config.value.snapshotEnabledDatabases, []);
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), false);
  backup.dispose();
});

test("isSnapshotEnabled treats all-scope as every database enabled", async () => {
  const backend = createBackend();
  // Force the "all" legacy scope so every database is treated as enabled.
  backend.invokeWorkbench = (command, payload = {}) => {
    if (command === "get_backup_config") {
      return Promise.resolve({
        enabled: true,
        intervalMinutes: 30,
        largeTableThreshold: 50000,
        maxPerDb: 50,
        databasesScope: "all",
        snapshotEnabledDatabases: [],
        auditRetentionDays: 90,
        storageDir: null,
        resolvedStorageDir: "/tmp/dbscout-backup",
      });
    }
    return createBackend().invokeWorkbench(command, payload);
  };
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), true);
  assert.equal(backup.isSnapshotEnabled("other", "anything"), true);
  backup.dispose();
});

test("setSnapshotEnabled adds a database to the whitelist and refreshes config", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), false);

  const ok = await backup.setSnapshotEnabled("demo", "game_db", true);
  assert.equal(ok, true);
  assert.deepEqual(backend.setSnapshotEnabledCalls, [
    { connectionId: "demo", database: "game_db", enabled: true },
  ]);
  assert.equal(backup.config.value.databasesScope, "selected");
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), true);
  // Other databases remain disabled.
  assert.equal(backup.isSnapshotEnabled("demo", "analytics"), false);
  backup.dispose();
});

test("setSnapshotEnabled removes a database from the whitelist", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  await backup.setSnapshotEnabled("demo", "game_db", true);
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), true);

  const ok = await backup.setSnapshotEnabled("demo", "game_db", false);
  assert.equal(ok, true);
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), false);
  assert.deepEqual(backend.snapshotEnabledDatabases, []);
  backup.dispose();
});

test("setSnapshotEnabled reports failure without throwing", async () => {
  const backend = createBackend();
  const failing = (command, payload) => {
    if (command === "set_snapshot_enabled") {
      return Promise.reject(new Error("写入配置失败"));
    }
    return backend.invokeWorkbench(command, payload);
  };
  const { setSnapshotEnabled, lastError } = useBackupCenter({
    invokeWorkbench: failing,
    listen: backend.listen,
  });
  const ok = await setSnapshotEnabled("demo", "game_db", true);
  assert.equal(ok, false);
  assert.match(lastError.value, /写入配置失败/);
});

test("setSnapshotEnabled transitions all-scope to selected, seeding the whitelist first", async () => {
  const backend = createBackend();
  // Start in "all" scope so the toggle must seed + switch to "selected".
  backend.setSnapshotScope("all");
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  // Disabling game_db from "all" scope: whitelist is seeded with all demo DBs
  // (the demo connection exposes game_db + analytics), then game_db is removed —
  // analytics should remain enabled.
  await backup.setSnapshotEnabled("demo", "game_db", false);
  assert.equal(backup.config.value.databasesScope, "selected");
  assert.equal(backup.isSnapshotEnabled("demo", "game_db"), false);
  assert.equal(backup.isSnapshotEnabled("demo", "analytics"), true);
  backup.dispose();
});

test("setAuditMode('shared') loads the shared change-log from the server", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  // Default mode is local.
  assert.equal(backup.auditMode.mode, "local");
  assert.equal(backup.auditLogs.value.length, 1);
  assert.equal(backup.sharedAuditLogs.value.length, 0);

  await backup.setAuditMode("shared");
  assert.equal(backup.auditMode.mode, "shared");
  assert.equal(backup.sharedAuditLogs.value.length, 1);
  assert.equal(backend.lastSharedAuditRequest.limit, 200);
  backup.dispose();
});

test("setAuditMode('local') falls back to the local audit store", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  await backup.setAuditMode("shared");
  await backup.setAuditMode("local");
  assert.equal(backup.auditMode.mode, "local");
  assert.equal(backup.auditLogs.value.length, 1);
  backup.dispose();
});

test("loadAuditLogs dispatches to the shared endpoint when in shared mode", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.open();
  backup.setFilters({ connectionId: "demo", database: "game_db", tableName: "hero" });
  await backup.setAuditMode("shared");
  // The shared request should carry the filters.
  assert.equal(backend.lastSharedAuditRequest.connectionId, "demo");
  assert.equal(backend.lastSharedAuditRequest.database, "game_db");
  assert.equal(backend.lastSharedAuditRequest.tableName, "hero");
  backup.dispose();
});

test("startImport prefills the draft from the snapshot header", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });

  const started = await backup.startImport();

  assert.equal(started, true);
  assert.equal(backup.importDraft.sourcePath, "/external/20260618-073000.sql");
  assert.equal(backup.importDraft.fileName, "20260618-073000.sql");
  assert.equal(backup.importDraft.connectionId, "demo");
  assert.equal(backup.importDraft.database, "game_db");
  assert.deepEqual(backup.importDraft.databases, ["game_db", "analytics"]);
  backup.dispose();
});

test("startImport returns false and keeps an empty draft when the picker is cancelled", async () => {
  const backend = createBackend();
  backend.setInspection(null);
  const backup = useBackupCenter({ ...backend });

  const started = await backup.startImport();

  assert.equal(started, false);
  assert.equal(backup.importDraft.sourcePath, "");
  backup.dispose();
});

test("confirmImport sends the target, clears the draft and reloads snapshots", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.startImport();
  const listCallsBefore = backend.listSnapshotCalls;

  const info = await backup.confirmImport();

  assert.equal(info.path, "/tmp/imported.sql");
  assert.deepEqual(backend.importSnapshotCalls, [
    { sourcePath: "/external/20260618-073000.sql", connectionId: "demo", database: "game_db" },
  ]);
  assert.equal(backup.importDraft.sourcePath, "");
  assert.ok(backend.listSnapshotCalls > listCallsBefore);
  backup.dispose();
});

test("confirmImport is blocked until a target connection and database are chosen", async () => {
  const backend = createBackend();
  backend.setInspection({
    sourcePath: "/external/mysqldump.sql",
    fileName: "mysqldump.sql",
    sizeBytes: 10,
    originConnectionId: null,
    originDatabase: null,
    originTs: null,
  });
  const backup = useBackupCenter({ ...backend });
  await backup.startImport();

  assert.equal(backup.importDraft.connectionId, "");
  assert.equal(await backup.confirmImport(), false);
  assert.deepEqual(backend.importSnapshotCalls, []);

  await backup.setImportTarget({ connectionId: "demo", database: "analytics" });
  assert.ok(await backup.confirmImport());
  assert.equal(backend.importSnapshotCalls.length, 1);
  backup.dispose();
});

test("changing the import connection clears the database and reloads options", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.startImport();

  await backup.setImportTarget({ connectionId: "other" });

  assert.equal(backup.importDraft.connectionId, "other");
  assert.equal(backup.importDraft.database, "");
  assert.deepEqual(backup.importDraft.databases, ["other_db"]);
  backup.dispose();
});

test("cancelImport discards the draft", async () => {
  const backend = createBackend();
  const backup = useBackupCenter({ ...backend });
  await backup.startImport();

  backup.cancelImport();

  assert.equal(backup.importDraft.sourcePath, "");
  assert.equal(backup.importDraft.connectionId, "");
  assert.equal(backup.importDraft.database, "");
  backup.dispose();
});

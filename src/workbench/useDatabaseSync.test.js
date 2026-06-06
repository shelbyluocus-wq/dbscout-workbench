import test from "node:test";
import assert from "node:assert/strict";

import { useDatabaseSync } from "./composables/useDatabaseSync.js";

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
  };
}

function createEventBus() {
  const listeners = [];
  return {
    listeners,
    listen(eventName, handler) {
      listeners.push({ eventName, handler });
      return () => {
        const index = listeners.findIndex((item) => item.handler === handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(payload) {
      for (const listener of listeners) listener.handler({ payload });
    },
  };
}

const connections = [
  { id: "mysql-1", host: "127.0.0.1", port: "3307", username: "root", label: "local" },
  { id: "demo", host: "demo", port: "3306", username: "root", label: "demo" },
];

const databases = ["dev_game", "live_game", "audit_log"];

async function previewReady(sync) {
  const result = await sync.preview();
  assert.equal(sync.dialog.status, "ready");
  assert.equal(sync.canExecute.value, true);
  return result;
}

test("open defaults the target database and chooses the first different source database", () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({}),
    storage: createStorage(),
  });

  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });

  assert.equal(sync.dialog.open, true);
  assert.equal(sync.dialog.connectionId, "mysql-1");
  assert.equal(sync.dialog.targetDatabase, "live_game");
  assert.equal(sync.dialog.sourceDatabase, "dev_game");
  assert.deepEqual(sync.availableSourceDatabases.value, ["dev_game", "audit_log"]);
});

test("setting source database to target database keeps a different valid source", () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({}),
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });

  sync.setSourceDatabase("live_game");

  assert.equal(sync.dialog.targetDatabase, "live_game");
  assert.equal(sync.dialog.sourceDatabase, "dev_game");
  assert.notEqual(sync.dialog.sourceDatabase, sync.dialog.targetDatabase);
  assert.ok(sync.availableSourceDatabases.value.includes(sync.dialog.sourceDatabase));
});

test("changing target database resets sync state and keeps source different", async () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({ tables: [{ name: "hero", action: "replace" }] }),
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await sync.preview();
  sync.dialog.errorMessage = "previous error";
  sync.dialog.progress = { done: 4, total: 10, message: "copy hero" };
  sync.dialog.jobId = "job-1";

  sync.setTargetDatabase("dev_game");

  assert.equal(sync.dialog.targetDatabase, "dev_game");
  assert.notEqual(sync.dialog.sourceDatabase, "dev_game");
  assert.ok(sync.availableSourceDatabases.value.includes(sync.dialog.sourceDatabase));
  assert.equal(sync.dialog.status, "idle");
  assert.equal(sync.result.value, null);
  assert.equal(sync.dialog.errorMessage, "");
  assert.deepEqual(sync.dialog.progress, { done: 0, total: 0, message: "" });
  assert.equal(sync.dialog.jobId, "");
});

test("manual exclusions trim, dedupe, and remove by name", () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({}),
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });

  sync.dialog.exclusionInput = " users , logs\n users\norders ";
  sync.addExclusionsFromInput();
  sync.dialog.exclusionInput = "logs";
  sync.addExclusionsFromInput();
  sync.removeExcludedTable("users");

  assert.deepEqual(sync.dialog.excludedTables, ["logs", "orders"]);
  assert.equal(sync.dialog.exclusionInput, "");
});

test("exclusion history persists and reloads by stable connection key", () => {
  const storage = createStorage({
    dbscout_database_sync_exclusions: JSON.stringify({
      "127.0.0.1:3307:root": ["keep_me"],
      demo: ["demo_only"],
    }),
  });
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({}),
    storage,
  });

  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  assert.deepEqual(sync.dialog.excludedTables, ["keep_me"]);

  sync.dialog.exclusionInput = "audit_log";
  sync.addExclusionsFromInput();
  sync.saveExclusionHistory();

  assert.deepEqual(JSON.parse(storage.store.dbscout_database_sync_exclusions), {
    "127.0.0.1:3307:root": ["keep_me", "audit_log"],
    demo: ["demo_only"],
  });

  const reloaded = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({}),
    storage,
  });
  reloaded.open({ kind: "database", connectionId: "mysql-1", database: "dev_game" });
  assert.deepEqual(reloaded.dialog.excludedTables, ["keep_me", "audit_log"]);
});

test("preview sends the expected command payload", async () => {
  const calls = [];
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command, payload) => {
      calls.push({ command, payload });
      return { tables: [{ name: "hero", action: "replace" }], warnings: ["drop target rows"] };
    },
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  sync.dialog.exclusionInput = "audit_log";
  sync.addExclusionsFromInput();

  const result = await sync.preview();

  assert.deepEqual(calls, [
    {
      command: "preview_database_sync",
      payload: {
        connectionId: "mysql-1",
        sourceDatabase: "dev_game",
        targetDatabase: "live_game",
        excludedTables: ["audit_log"],
      },
    },
  ]);
  assert.equal(sync.dialog.status, "ready");
  assert.equal(result.tables.length, 1);
  assert.equal(sync.result.value, result);
});

test("pending manual exclusion input disables execution after preview", async () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({ tables: [{ name: "hero", action: "copy" }] }),
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);

  sync.dialog.exclusionInput = "audit_log";

  assert.equal(sync.canExecute.value, false);
});

test("execute does not run overwrite sync when pending manual exclusions change preview inputs", async () => {
  const calls = [];
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command, payload) => {
      calls.push({ command, payload });
      if (command === "preview_database_sync") return { tables: [{ name: "hero", action: "copy" }] };
      return { status: "succeeded" };
    },
    createJobId: () => "manual-exclusion-job",
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);
  sync.dialog.exclusionInput = "audit_log";

  const result = await sync.execute();

  assert.equal(result, null);
  assert.equal(sync.dialog.status, "idle");
  assert.equal(sync.canExecute.value, false);
  assert.equal(sync.result.value, null);
  assert.deepEqual(calls.map((call) => call.command), ["preview_database_sync"]);
});

test("progress events ignore other jobs and update the matching job", async () => {
  const bus = createEventBus();
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({ ok: true }),
    listen: bus.listen,
    createJobId: () => "job-1",
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);

  await sync.execute();
  bus.emit({ jobId: "other-job", status: "running", done: 2, total: 10, message: "wrong" });
  assert.equal(sync.dialog.progress.done, 0);
  assert.equal(sync.dialog.progress.message, "");

  bus.emit({ jobId: "job-1", status: "running", done: 3, total: 10, message: "copy hero" });

  assert.equal(sync.dialog.status, "running");
  assert.equal(sync.dialog.progress.done, 3);
  assert.equal(sync.dialog.progress.total, 10);
  assert.equal(sync.dialog.progress.message, "copy hero");
});

test("execute maps success, failure, and restoring statuses", async () => {
  for (const backendStatus of ["succeeded", "completed"]) {
    const successResult = { status: backendStatus, syncedTables: 5 };
    const success = useDatabaseSync({
      connections,
      databases,
      invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : successResult),
      createJobId: () => `success-${backendStatus}`,
      storage: createStorage(),
    });
    success.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
    await previewReady(success);
    await success.execute();
    assert.equal(success.dialog.status, "succeeded", backendStatus);
    assert.equal(success.result.value, successResult, backendStatus);
  }

  const failure = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command) => {
      if (command === "preview_database_sync") return { tables: [{ name: "hero", action: "copy" }] };
      throw new Error("sync failed");
    },
    createJobId: () => "failure-job",
    storage: createStorage(),
  });
  failure.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(failure);
  await failure.execute();
  assert.equal(failure.dialog.status, "failed");
  assert.equal(failure.dialog.errorMessage, "sync failed");

  const restoring = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : { restored: true, status: "restoring" }),
    createJobId: () => "restore-job",
    storage: createStorage(),
  });
  restoring.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(restoring);
  await restoring.execute();
  assert.equal(restoring.dialog.status, "restoring");
  assert.deepEqual(restoring.result.value, { restored: true, status: "restoring" });
});

test("execute maps restored failure result statuses to failed without altering the result", async () => {
  for (const backendStatus of ["failedRestored", "failed-restored"]) {
    const backendResult = {
      status: backendStatus,
      backupDatabase: "live_game_backup_20260605",
      error: "copy failed",
    };
    const sync = useDatabaseSync({
      connections,
      databases,
      invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : backendResult),
      createJobId: () => `restore-${backendStatus}`,
      storage: createStorage(),
    });
    sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
    await previewReady(sync);

    await sync.execute();

    assert.equal(sync.dialog.status, "failed", backendStatus);
    assert.equal(sync.result.value, backendResult, backendStatus);
    assert.deepEqual(sync.result.value, backendResult, backendStatus);
  }
});

test("execute maps unrecovered restore failure statuses to failed and preserves backup database", async () => {
  for (const backendStatus of ["failedRestoreFailed", "restore-failed", "failed-restore-failed"]) {
    const backendResult = {
      status: backendStatus,
      backupDatabase: "live_game_backup_manual",
      backup_database: "live_game_backup_manual_snake",
      error: "restore failed",
    };
    const sync = useDatabaseSync({
      connections,
      databases,
      invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : backendResult),
      createJobId: () => `manual-${backendStatus}`,
      storage: createStorage(),
    });
    sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
    await previewReady(sync);

    await sync.execute();

    assert.notEqual(sync.dialog.status, "succeeded", backendStatus);
    assert.equal(sync.dialog.status, "failed", backendStatus);
    assert.equal(sync.result.value, backendResult, backendStatus);
    assert.equal(sync.result.value.backupDatabase, "live_game_backup_manual", backendStatus);
    assert.equal(sync.result.value.backup_database, "live_game_backup_manual_snake", backendStatus);
  }
});

test("changing exclusions invalidates preview result and run state", async () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async () => ({ tables: [{ name: "hero", action: "copy" }] }),
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await sync.preview();
  sync.dialog.errorMessage = "previous error";
  sync.dialog.progress = { done: 6, total: 9, message: "copy hero" };
  sync.dialog.jobId = "job-stale";

  sync.addExcludedTable("audit_log");

  assert.equal(sync.dialog.status, "idle");
  assert.equal(sync.canExecute.value, false);
  assert.equal(sync.result.value, null);
  assert.equal(sync.dialog.errorMessage, "");
  assert.deepEqual(sync.dialog.progress, { done: 0, total: 0, message: "" });
  assert.equal(sync.dialog.jobId, "");

  await sync.preview();
  assert.equal(sync.canExecute.value, true);
  sync.removeExcludedTable("audit_log");

  assert.equal(sync.dialog.status, "idle");
  assert.equal(sync.canExecute.value, false);
  assert.equal(sync.result.value, null);
});

test("localStorage write failure is best effort after successful execute", async () => {
  const backendResult = { status: "succeeded", syncedTables: 3 };
  const storage = createStorage();
  storage.setItem = () => {
    throw new Error("quota exceeded");
  };
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : backendResult),
    createJobId: () => "history-best-effort",
    storage,
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);

  const result = await sync.execute();

  assert.equal(result, backendResult);
  assert.equal(sync.dialog.status, "succeeded");
  assert.equal(sync.result.value, backendResult);
  assert.equal(sync.dialog.errorMessage, "");
});

test("execute handles progress listener setup failure without rejecting", async () => {
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : { status: "succeeded" }),
    listen: async () => {
      throw new Error("listener unavailable");
    },
    createJobId: () => "listener-failure",
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);

  const result = await sync.execute();

  assert.equal(result, null);
  assert.equal(sync.dialog.status, "failed");
  assert.match(sync.dialog.errorMessage, /listener unavailable/);
  assert.equal(sync.result.value, null);
});

test("dispose unregisters the stored progress listener", async () => {
  const bus = createEventBus();
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: async (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : { status: "succeeded" }),
    listen: bus.listen,
    createJobId: () => "dispose-job",
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);
  await sync.execute();

  assert.equal(bus.listeners.length, 1);
  sync.dialog.jobId = "dispose-job";
  sync.dispose();
  bus.emit({ jobId: "dispose-job", status: "running", done: 7, total: 10, message: "should not apply" });

  assert.equal(bus.listeners.length, 0);
  assert.deepEqual(sync.dialog.progress, { done: 0, total: 0, message: "" });
});

test("stale preview completion cannot mutate a reopened dialog", async () => {
  let resolvePreview;
  const previewPromise = new Promise((resolve) => {
    resolvePreview = resolve;
  });
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: () => previewPromise,
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  const pending = sync.preview();
  sync.close();
  sync.open({ kind: "database", connectionId: "mysql-1", database: "audit_log" });

  resolvePreview({ tables: [{ name: "stale", action: "copy" }] });
  await pending;

  assert.equal(sync.dialog.open, true);
  assert.equal(sync.dialog.targetDatabase, "audit_log");
  assert.equal(sync.dialog.status, "idle");
  assert.equal(sync.result.value, null);
});

test("stale execute completion cannot mutate a reopened dialog", async () => {
  let resolveExecute;
  const executePromise = new Promise((resolve) => {
    resolveExecute = resolve;
  });
  const sync = useDatabaseSync({
    connections,
    databases,
    invokeWorkbench: (command) => (command === "preview_database_sync" ? { tables: [{ name: "hero", action: "copy" }] } : executePromise),
    createJobId: () => "stale-execute",
    storage: createStorage(),
  });
  sync.open({ kind: "database", connectionId: "mysql-1", database: "live_game" });
  await previewReady(sync);
  const pending = sync.execute();
  sync.close();
  sync.open({ kind: "database", connectionId: "mysql-1", database: "audit_log" });

  resolveExecute({ status: "succeeded", syncedTables: 12 });
  await pending;

  assert.equal(sync.dialog.open, true);
  assert.equal(sync.dialog.targetDatabase, "audit_log");
  assert.equal(sync.dialog.status, "idle");
  assert.equal(sync.result.value, null);
  assert.equal(sync.dialog.jobId, "");
});

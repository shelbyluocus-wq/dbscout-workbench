import test from "node:test";
import assert from "node:assert/strict";
import { createReleaseRealDriver, resolvePlatformConnection } from "./composables/useReleaseRealDriver.js";

function makeIo(signal = new AbortController().signal) {
  const logs = [];
  const progresses = [];
  return {
    signal,
    logsList: logs,
    progresses,
    log(text, tone = "") {
      logs.push({ text, tone });
    },
    logs(entries) {
      for (const entry of entries) {
        logs.push(typeof entry === "string" ? { text: entry, tone: "" } : { text: entry.text, tone: entry.tone || "" });
      }
    },
    progress(value) {
      progresses.push(value);
    },
  };
}

test("resolvePlatformConnection matches explicit id, exact databases, and game family without cross-family guessing", () => {
  const connections = [
    { id: "demo", kind: "mysql", host: "127.0.0.1" },
    { id: "mysql-1", kind: "mysql", host: "192.168.1.223" },
    { id: "mysql-4", kind: "mysql", host: "192.168.1.243" },
    { id: "ch-1", kind: "clickhouse", host: "192.168.1.250" },
    { id: "ro-1", kind: "mysql", host: "192.168.1.243", readOnly: true },
  ];
  const databasesByConnection = {
    "mysql-1": ["edota_3cfg", "edota_8cfg", "newsgcfg"],
    "mysql-4": ["newsg_4cfg", "newsg_tw_cfg", "newsg_tap_cfg"],
  };

  assert.equal(
    resolvePlatformConnection(
      { sourceDatabase: "newsg_4cfg", targetDatabase: "newsg_tw_cfg" },
      connections,
      databasesByConnection,
    )?.id,
    "mysql-4",
  );

  // `newsgcfg` on mysql-1 must not be mistaken for the `newsg_*` family.
  assert.equal(
    resolvePlatformConnection(
      { sourceDatabase: "newsg_99cfg", targetDatabase: "newsg_vn_cfg" },
      connections,
      databasesByConnection,
    )?.id,
    "mysql-4",
  );

  assert.equal(
    resolvePlatformConnection(
      { connectionId: "mysql-1", sourceDatabase: "newsg_4cfg", targetDatabase: "newsg_tw_cfg" },
      connections,
      databasesByConnection,
    )?.id,
    "mysql-1",
  );

  // Sole connection belonging to edota_* must not be auto-picked for newsg_*.
  assert.equal(
    resolvePlatformConnection(
      { sourceDatabase: "newsg_4cfg", targetDatabase: "newsg_tw_cfg" },
      [connections[1]],
      databasesByConnection,
    ),
    null,
  );
});

test("real driver handles non-demo tasks and delegates demo runs", () => {
  const driver = createReleaseRealDriver({ invoke: async () => ({}) });
  assert.equal(driver.handles("db.sync", { demoRun: false }), true);
  assert.equal(driver.handles("db.sync", { demoRun: true }), false);
  assert.equal(driver.handles("build.cocos", { demoRun: false }), false);
});

test("real driver executes db.sync, enriches snapshot metadata, and supports db.restore and db.plans", async () => {
  const calls = [];
  const listeners = new Map();
  const driver = createReleaseRealDriver({
    createJobId: () => "job-fixed",
    listen: async (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    invoke: async (cmd, payload) => {
      calls.push([cmd, payload]);
      if (cmd === "sync_database_overwrite") {
        listeners.get("database-sync-progress")?.({
          payload: { jobId: "job-fixed", completedTables: 2, totalTables: 4, stage: "copy", currentTable: "heroprop", message: "copying heroprop" },
        });
        return {
          status: "succeeded",
          copiedTables: ["heroprop", "mountstarprop"],
          droppedTables: ["legacy_tmp"],
          copiedRows: 1240,
          backupSnapshotPath: "/snapshots/newsg_tw_cfg/20261028.sql",
          message: "Sync complete",
          warnings: [],
        };
      }
      if (cmd === "list_snapshots") {
        return [{ path: "/snapshots/newsg_tw_cfg/20261028.sql", ts: 1761609600000, tableCount: 5 }];
      }
      if (cmd === "restore_snapshot") {
        return { ok: true };
      }
      if (cmd === "release_execute_plan_writes") {
        return {
          statements: 1,
          affectedRows: 2,
          executedSql: ["UPDATE `heroprop` SET `OpenFlag` = 1 WHERE `ID` IN (1061, 1062);"],
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    },
  });

  const syncIo = makeIo();
  const syncResult = await driver.run("db.sync", {
    demoRun: false,
    connectionId: "mysql-4",
    platform: { sourceDatabase: "newsg_4cfg", targetDatabase: "newsg_tw_cfg" },
    syncPlan: { excluded: ["platspecfgtable"] },
  }, syncIo);

  assert.equal(syncResult.tables, 2);
  assert.equal(syncResult.rows, 1240);
  assert.equal(syncResult.backup.simulated, false);
  assert.equal(syncResult.backup.tables, 5);
  assert.ok(syncIo.logsList.some((entry) => entry.text.includes("copying heroprop")));

  const restoreIo = makeIo();
  const restoreResult = await driver.run("db.restore", {
    demoRun: false,
    connectionId: "mysql-4",
    platform: { targetDatabase: "newsg_tw_cfg" },
    backup: syncResult.backup,
  }, restoreIo);
  assert.equal(restoreResult.tables, 5);

  const planIo = makeIo();
  const planResult = await driver.run("db.plans", {
    demoRun: false,
    connectionId: "mysql-4",
    platform: { targetDatabase: "newsg_tw_cfg" },
    plan: {
      counts: { open: 2, close: 0 },
      writes: [{ table: "heroprop", keyColumns: ["ID"], flagColumn: "OpenFlag", flag: 1, keys: [[1061], [1062]] }],
    },
  }, planIo);
  assert.equal(planResult.statements, 1);
  assert.equal(planResult.affectedRows, 2);
  assert.equal(calls.map(([cmd]) => cmd).join(","), "sync_database_overwrite,list_snapshots,restore_snapshot,release_execute_plan_writes");
});

test("real driver resolves SVN conflicts, runs client sync and transfer with skipSvnUpdate, and blocks diff on remaining conflicts", async () => {
  let statusCheckCount = 0;
  const calls = [];
  const driver = createReleaseRealDriver({
    createJobId: () => "job-client",
    listen: async () => () => {},
    invoke: async (cmd, payload) => {
      calls.push([cmd, payload]);
      if (cmd === "svn_wc_resolve") return null;
      if (cmd === "svn_wc_status") {
        statusCheckCount += 1;
        if (statusCheckCount === 1) {
          return [{ path: "assets/props/props/heroprop.json", item: "modified", props: "none", treeConflict: false }];
        }
        return [{ path: "assets/config/Config.ts", item: "conflicted", props: "none", treeConflict: false }];
      }
      if (cmd === "release_client_sync_run") {
        return { added: 3, modified: 5, deleted: 1, excluded: 12, warnings: [] };
      }
      if (cmd === "table_transfer_run") {
        assert.equal(payload.request.skipSvnUpdate, true);
        return { outputDir: "/tmp/out", updatedDirs: ["props"], copiedFiles: 490 };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    },
  });

  const resolveResult = await driver.run("client.svnResolve", {
    demoRun: false,
    platform: { targetClient: "/wc/tw" },
    previous: { revision: 52817, conflicts: ["a.ts", "b.ts"] },
    conflicts: [
      { path: "a.ts", choice: "theirs" },
      { path: "b.ts", choice: "mine" },
    ],
  }, makeIo());
  assert.equal(resolveResult.resolved, 2);

  const syncResult = await driver.run("client.sync", {
    demoRun: false,
    platform: { sourceClient: "/wc/dev", targetClient: "/wc/tw" },
    rules: ["assets/config/Config.ts"],
    mirrorDeletes: true,
  }, makeIo());
  assert.equal(syncResult.modified, 5);

  const transferResult = await driver.run("client.transfer", {
    demoRun: false,
    platform: { targetClient: "/wc/tw" },
    template: { name: "J2", scriptPath: "/tools/gen.sh", conflictStrategy: "theirs-full" },
  }, makeIo());
  assert.equal(transferResult.copiedFiles, 490);

  await assert.rejects(
    () => driver.run("client.diff", { demoRun: false, platform: { targetClient: "/wc/tw" } }, makeIo()),
    (error) => error?.code === "svnConflictsRemain",
  );
});

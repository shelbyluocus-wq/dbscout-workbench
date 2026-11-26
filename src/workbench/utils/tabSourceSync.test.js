import test from "node:test";
import assert from "node:assert/strict";
import { createTabSourceSync } from "./tabSourceSync.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const selected = { connectionId: "mysql-1", database: "app" };
  const calls = [];
  const gates = [];
  const sync = createTabSourceSync({
    getSelected: () => ({ ...selected }),
    async selectConnection(connectionId, options) {
      calls.push(["connection", connectionId, options]);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      selected.connectionId = connectionId;
      selected.database = options?.preferredDatabase || "default";
    },
    async selectDatabase({ connectionId, database }) {
      calls.push(["database", connectionId, database]);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      selected.connectionId = connectionId;
      selected.database = database;
    },
  });
  return { selected, calls, gates, sync };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("same-source tabs do not touch the sidebar", async () => {
  const { calls, sync } = harness();
  assert.equal(await sync.syncToTab({ connectionId: "mysql-1", database: "app" }), true);
  assert.deepEqual(calls, []);
});

test("cross-connection tabs switch straight to the tab database", async () => {
  const { calls, gates, selected, sync } = harness();
  const done = sync.syncToTab({ connectionId: "mysql-2", database: "reports" });
  await flush();
  gates[0].resolve();
  assert.equal(await done, true);
  assert.deepEqual(calls, [["connection", "mysql-2", { preferredDatabase: "reports" }]]);
  assert.deepEqual(selected, { connectionId: "mysql-2", database: "reports" });
});

test("a newer activation stops an older sync from selecting afterwards", async () => {
  const { calls, gates, sync } = harness();
  const older = sync.syncToTab({ connectionId: "mysql-2", database: "reports" });
  await flush();
  const newer = sync.syncToTab({ connectionId: "mysql-1", database: "billing" });
  await flush();
  gates[0].resolve();
  assert.equal(await older, false);
  gates[1].resolve();
  assert.equal(await newer, true);
  // The older sync never issues a follow-up database selection.
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["connection", "mysql-2", { preferredDatabase: "reports" }],
    ["database", "mysql-1", "billing"],
  ]);
});

test("selection failures are swallowed because the status bar already reports them", async () => {
  const sync = createTabSourceSync({
    getSelected: () => ({ connectionId: "mysql-1", database: "app" }),
    selectConnection: async () => { throw new Error("offline"); },
    selectDatabase: async () => {},
  });
  assert.equal(await sync.syncToTab({ connectionId: "mysql-9", database: "x" }), false);
});

test("a connection switch superseded by a direct sidebar or rail click does not overwrite the new database", async () => {
  const selected = { connectionId: "mysql-1", database: "app" };
  const databaseCalls = [];
  const sync = createTabSourceSync({
    getSelected: () => ({ ...selected }),
    async selectConnection() {
      selected.connectionId = "mysql-2";
      selected.database = "clicked_in_sidebar";
      return "superseded";
    },
    async selectDatabase(payload) {
      databaseCalls.push(payload);
    },
  });

  assert.equal(await sync.syncToTab({ connectionId: "mysql-2", database: "stale_tab_db" }), false);
  assert.deepEqual(databaseCalls, []);
  assert.deepEqual(selected, { connectionId: "mysql-2", database: "clicked_in_sidebar" });
});

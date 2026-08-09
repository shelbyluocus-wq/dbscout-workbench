import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS,
  createTableModifiedTimeAutoRefresh,
  mergeTableModifiedTimes,
} from "./composables/tableModifiedTimeRefresh.js";
import { createDatabaseWorkPriority } from "./composables/databaseWorkPriority.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("modified-time merge preserves table state and only replaces changed timestamps", () => {
  const unchanged = {
    table_name: "accounts",
    modified_at: "2026-07-15 10:00:00",
    columns: [{ column_name: "id" }],
  };
  const changed = {
    table_name: "orders",
    modified_at: "2026-07-15 09:00:00",
    columns: [{ column_name: "order_id" }],
    schemaLoaded: true,
  };
  const current = [unchanged, changed];

  const result = mergeTableModifiedTimes(current, [
    { table_name: "accounts", modified_at: "2026-07-15 10:00:00" },
    { table_name: "orders", modified_at: "2026-07-15 11:30:00" },
    { table_name: "external_new_table", modified_at: "2026-07-15 11:31:00" },
  ]);

  assert.equal(result.updatedCount, 1);
  assert.strictEqual(result.tables[0], unchanged);
  assert.notStrictEqual(result.tables[1], changed);
  assert.equal(result.tables[1].modified_at, "2026-07-15 11:30:00");
  assert.equal(result.tables[1].modifiedAt, "2026-07-15 11:30:00");
  assert.strictEqual(result.tables[1].columns, changed.columns);
  assert.equal(result.tables[1].schemaLoaded, true);
  assert.equal(result.tables.length, 2);
});

test("auto refresh runs every wall-clock minute without foreground visibility gating", async () => {
  let currentTime = 0;
  let scheduled = null;
  const calls = [];
  const scheduler = createTableModifiedTimeAutoRefresh({
    refresh: async (source) => calls.push(source),
    getSource: () => ({ connectionId: "mysql-main", database: "app" }),
    now: () => currentTime,
    setTimer(callback, delay) {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimer(timer) {
      if (scheduled === timer) scheduled = null;
    },
  });

  scheduler.start();
  assert.equal(scheduled.delay, TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS);

  currentTime = TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS;
  scheduled.callback();
  await Promise.resolve();
  assert.deepEqual(calls, [{ connectionId: "mysql-main", database: "app" }]);
  assert.equal(scheduled.delay, TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS);

  scheduler.stop();
  assert.equal(scheduled, null);
});

test("auto refresh skips missed background ticks without creating a request burst", async () => {
  let currentTime = 0;
  let scheduled = null;
  const pending = deferred();
  let refreshCount = 0;
  const scheduler = createTableModifiedTimeAutoRefresh({
    refresh: () => {
      refreshCount += 1;
      return pending.promise;
    },
    getSource: () => ({ connectionId: "mysql-main", database: "app" }),
    now: () => currentTime,
    setTimer(callback, delay) {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimer() {},
  });

  scheduler.start();
  currentTime = 185_000;
  scheduled.callback();
  await Promise.resolve();

  assert.equal(refreshCount, 1);
  assert.equal(scheduled.delay, 55_000);

  currentTime = 240_000;
  scheduled.callback();
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  pending.resolve();
  scheduler.stop();
});

test("auto refresh yields to a foreground table open and still runs afterwards", async () => {
  let currentTime = 0;
  let scheduled = null;
  let refreshCount = 0;
  const source = { connectionId: "mysql-main", database: "app" };
  const priority = createDatabaseWorkPriority();
  const releaseForeground = priority.beginForeground(source);
  const scheduler = createTableModifiedTimeAutoRefresh({
    refresh: async () => {
      refreshCount += 1;
    },
    runBackground: priority.runBackground,
    getSource: () => source,
    now: () => currentTime,
    setTimer(callback, delay) {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimer() {},
  });

  scheduler.start();
  currentTime = TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS;
  scheduled.callback();
  await Promise.resolve();
  assert.equal(refreshCount, 0);

  releaseForeground();
  for (let turn = 0; turn < 10 && refreshCount === 0; turn += 1) await Promise.resolve();
  assert.equal(refreshCount, 1);

  scheduler.stop();
  priority.dispose();
});

test("workbench starts and stops the silent refresh with its mounted lifetime", () => {
  const workbench = fs.readFileSync(new URL("./MySqlWorkbench.vue", import.meta.url), "utf8");
  assert.match(workbench, /onMounted\(async \(\) => \{[\s\S]*?tableModifiedTimeAutoRefresh\.start\(\)/);
  assert.match(workbench, /onBeforeUnmount\(\(\) => \{[\s\S]*?tableModifiedTimeAutoRefresh\.stop\(\)/);
});

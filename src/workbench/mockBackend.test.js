import test from "node:test";
import assert from "node:assert/strict";
import { mockWorkbenchInvoke } from "./mock/mockBackend.js";
import { getOrInitRows } from "./mock/mockRows.js";
import { resolveMockSchema } from "./mock/mockSchema.js";

test("mock schema can expand demo game_db for large table stress runs", () => {
  const schema = resolveMockSchema("demo", "game_db", { tableCount: 800 });

  assert.equal(schema.length, 800);
  assert.equal(schema[0].table_name, "player");
  assert.match(schema[schema.length - 1].table_name, /^stress_table_/);
  assert.equal(resolveMockSchema("demo-staging", "game_db", { tableCount: 800 }).length, 800);
  assert.notEqual(resolveMockSchema("demo-staging", "analytics_db", { tableCount: 800 }).length, 800);
});

test("mock insert_row rejects duplicate primary keys", async () => {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
  });

  await assert.rejects(
    () => mockWorkbenchInvoke("insert_row", {
      request: {
        sessionId: page.sessionId,
        draft: { id: "1", username: "duplicate_user" },
      },
    }),
    /主键重复/,
  );
});

test("mock preview_database_sync plans copied, removed, and excluded tables deterministically", async () => {
  const preview = await mockWorkbenchInvoke("preview_database_sync", {
    connectionId: "demo-staging",
    sourceDatabase: "analytics_db",
    targetDatabase: "game_db",
    excludedTables: ["staging_flag"],
  });

  assert.equal(preview.status, "ready");
  assert.deepEqual(
    preview.tables.map((table) => table.name).slice(0, 3),
    ["ab_test_config", "daily_active_user", "event_log"],
  );
  assert.deepEqual(
    preview.tables.filter((table) => table.action === "copy").map((table) => table.name),
    ["ab_test_config", "daily_active_user", "event_log", "retention_cohort", "revenue_report"],
  );
  assert.deepEqual(
    preview.tables.filter((table) => table.action === "preserve-excluded").map((table) => table.name),
    ["staging_flag"],
  );
  assert.ok(preview.tables.some((table) => table.name === "player" && table.action === "remove"));
  assert.ok(preview.warnings.some((warning) => warning.includes("staging_flag")));
});

test("mock sync_database_overwrite preserves excluded target tables and copies source tables", async () => {
  const connectionId = "demo-staging";
  const sourceDatabase = "analytics_db";
  const targetDatabase = "game_db";
  const excludedRows = getOrInitRows(connectionId, targetDatabase, "staging_flag");
  const originalExcludedFirstRow = { ...excludedRows[0] };
  const sourceEventRows = getOrInitRows(connectionId, sourceDatabase, "event_log");
  const sourceEventFirstRow = { ...sourceEventRows[0] };

  const result = await mockWorkbenchInvoke("sync_database_overwrite", {
    connectionId,
    sourceDatabase,
    targetDatabase,
    excludedTables: ["staging_flag"],
    jobId: "mock-sync-test",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.jobId, "mock-sync-test");
  assert.deepEqual(result.preservedTables, ["staging_flag"]);
  assert.deepEqual(result.copiedTables, ["ab_test_config", "daily_active_user", "event_log", "retention_cohort", "revenue_report"]);
  assert.ok(result.removedTables.includes("player"));
  assert.deepEqual(getOrInitRows(connectionId, targetDatabase, "staging_flag")[0], originalExcludedFirstRow);
  assert.deepEqual(getOrInitRows(connectionId, targetDatabase, "event_log")[0], sourceEventFirstRow);
  assert.deepEqual(
    resolveMockSchema(connectionId, targetDatabase).map((table) => table.table_name),
    ["ab_test_config", "daily_active_user", "event_log", "retention_cohort", "revenue_report", "staging_flag"],
  );
});

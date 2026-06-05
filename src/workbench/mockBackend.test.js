import test from "node:test";
import assert from "node:assert/strict";
import { mockWorkbenchInvoke } from "./mock/mockBackend.js";
import { resolveMockSchema } from "./mock/mockSchema.js";

test("mock schema can expand demo game_db for large table stress runs", () => {
  const schema = resolveMockSchema("demo", "game_db", { tableCount: 800 });

  assert.equal(schema.length, 800);
  assert.equal(schema[0].table_name, "player");
  assert.match(schema[schema.length - 1].table_name, /^stress_table_/);
  assert.equal(resolveMockSchema("demo-staging", "game_db", { tableCount: 800 }).length, 800);
  assert.notEqual(resolveMockSchema("demo-staging", "analytics_db", { tableCount: 800 }).length, 800);
});

test("mock search_values returns first preview match per table", async () => {
  const results = await mockWorkbenchInvoke("search_values", {
    request: {
      connectionId: "demo",
      database: "game_db",
      query: "冒险者",
      limit: 50,
    },
  });

  assert.ok(results.some((item) => item.tableName === "player"));
  assert.ok(results.every((item) => item.previewValue));
  assert.ok(results.every((item) => item.columnName));
  assert.equal(results.every((item) => "matchCount" in item), false);
});

test("mock search_values clamps zero limit to one result", async () => {
  const results = await mockWorkbenchInvoke("search_values", {
    request: {
      connectionId: "demo",
      database: "game_db",
      query: "1",
      limit: 0,
    },
  });

  assert.ok(results.length > 0);
  assert.ok(results.length <= 1);
});

test("mock search_data preserves legacy match summary shape", async () => {
  const results = await mockWorkbenchInvoke("search_data", {
    connectionId: "demo",
    database: "game_db",
    request: { query: "1" },
  });

  assert.ok(results.some((item) => item.tableName === "player"));
  assert.ok(results.every((item) => Number.isInteger(item.matchCount)));
  assert.ok(results.every((item) => Array.isArray(item.matches)));
  assert.ok(results.every((item) => item.matches.every((match) => match.columnName && "value" in match)));
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

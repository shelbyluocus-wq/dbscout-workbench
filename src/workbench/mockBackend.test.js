import test from "node:test";
import assert from "node:assert/strict";
import { mockWorkbenchInvoke, resetMockWorkbenchState } from "./mock/mockBackend.js";
import { onMockEvent } from "./mock/mockEventBus.js";
import { getOrInitRows, rowCache } from "./mock/mockRows.js";
import { mockDatabaseSchemas, mockTableDefs, resetMockDatabaseSchemas, resolveMockSchema } from "./mock/mockSchema.js";

test("mock table-session close is idempotent and invalidates later page fetches", async () => {
  resetMockWorkbenchState();
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    options: { page: 1, pageSize: 10 },
  });

  assert.deepEqual(
    await mockWorkbenchInvoke("close_table_session", { sessionId: page.sessionId }),
    { closed: true },
  );
  assert.deepEqual(
    await mockWorkbenchInvoke("close_table_session", { sessionId: page.sessionId }),
    { closed: false },
  );
  await assert.rejects(
    mockWorkbenchInvoke("fetch_table_page", {
      sessionId: page.sessionId,
      request: { page: 2, pageSize: 10 },
    }),
    /会话.*失效|session.*expired/i,
  );
  for (const [command, request] of [
    ["update_cell", { sessionId: page.sessionId, rowIdentity: { id: "1" }, columnName: "username", oldValue: "Ada", newValue: "Bob" }],
    ["insert_row", { sessionId: page.sessionId, draft: { id: "999" } }],
    ["delete_rows", { sessionId: page.sessionId, rowIdentities: [{ id: "1" }] }],
  ]) {
    await assert.rejects(
      mockWorkbenchInvoke(command, { request }),
      /会话.*失效|session.*expired/i,
    );
  }
});

test("mock table pages prefer an explicit offset while legacy page requests remain compatible", async () => {
  resetMockWorkbenchState();
  const first = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    options: { page: 1, pageSize: 5 },
  });
  const legacy = await mockWorkbenchInvoke("fetch_table_page", {
    sessionId: first.sessionId,
    request: { page: 2, pageSize: 5 },
  });
  const offset = await mockWorkbenchInvoke("fetch_table_page", {
    sessionId: first.sessionId,
    request: { page: 99, pageSize: 5, offset: 5 },
  });

  assert.deepEqual(offset.rows, legacy.rows);
  assert.equal(offset.totalRows, 10);
});

test("mock batch schema command returns every requested table in request order", async () => {
  resetMockWorkbenchState();

  const schemas = await mockWorkbenchInvoke("get_table_schemas", {
    connectionId: "demo",
    database: "game_db",
    tableNames: ["player", "hero", "item"],
    force: false,
  });

  assert.deepEqual(schemas.map((schema) => schema.table_name), ["player", "hero", "item"]);
  assert.ok(schemas.every((schema) => Array.isArray(schema.columns) && schema.columns.length > 0));
});

test("mock table search exposes begin next and cancel job semantics", async () => {
  resetMockWorkbenchState();
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    options: { page: 1, pageSize: 10 },
  });
  const query = String(page.rows[0].username);

  const result = await mockWorkbenchInvoke("begin_table_search", {
    request: {
      sessionId: page.sessionId,
      query,
      mode: "exact",
      sort: null,
      resultPageSize: 100,
    },
  });

  assert.match(result.jobId, /^mock-table-search-/);
  assert.ok(result.rows.length > 0);
  assert.equal(result.rowKeys.length, result.rows.length);
  assert.ok(result.matches.some((match) => match.columnName === "username" && match.kind === "exact"));
  assert.equal(typeof result.scannedRows, "number");
  assert.equal(typeof result.complete, "boolean");
  assert.deepEqual(
    await mockWorkbenchInvoke("cancel_table_search", { jobId: result.jobId }),
    { cancelled: true },
  );
  await assert.rejects(
    mockWorkbenchInvoke("next_table_search_page", { request: { jobId: result.jobId } }),
    /搜索任务|search job/i,
  );
});
import { buildTableDesignPayload, normalizeTableDesign } from "./utils/tableDesign.js";

async function withMockLocation(search, action) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { search },
  });
  try {
    return await action();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else delete globalThis.location;
  }
}

test("performance profile routes connection schema and pages through mockWorkbenchInvoke", async () => {
  await withMockLocation("?perfProfile=deterministic-v1&scenario=rows-100k-500-pk", async () => {
    const connections = await mockWorkbenchInvoke("list_connections", {});
    assert.deepEqual(connections.map((connection) => connection.id), ["perf-fixture"]);
    assert.deepEqual(
      await mockWorkbenchInvoke("list_databases", { connectionId: "perf-fixture" }),
      ["perf_db"],
    );

    const tables = await mockWorkbenchInvoke("list_tables", {
      connectionId: "perf-fixture",
      database: "perf_db",
    });
    assert.equal(tables.length, 1);
    assert.equal(tables[0].columnCount, 500);

    const first = await mockWorkbenchInvoke("open_table_session", {
      connectionId: "perf-fixture",
      database: "perf_db",
      tableName: tables[0].table_name,
      options: { page: 1, pageSize: 25, includeTotal: true },
    });
    assert.equal(first.rows.length, 25);
    assert.equal(first.totalRows, 25);
    assert.equal(first.totalRowsExact, false);
    assert.deepEqual(first.primaryKeys, ["id"]);
    assert.equal(first.rows[0].field_001, "rows-100k-500-pk|r000001|c001");

    const second = await mockWorkbenchInvoke("fetch_table_page", {
      sessionId: first.sessionId,
      request: { page: 2, pageSize: 25, includeTotal: false },
    });
    assert.equal(second.rows[0].id, "26");
    assert.equal(second.totalRowsExact, false);
    assert.equal(second.hasMore, true);

    const count = await mockWorkbenchInvoke("fetch_table_count", {
      sessionId: first.sessionId,
      requestId: "perf-count-1",
      filter: null,
    });
    assert.deepEqual(count, { totalRows: 100_000, exact: true, estimated: false });

    const metadata = await mockWorkbenchInvoke("perf_fixture_metadata", {});
    assert.equal(metadata.profile, "deterministic-v1");
    assert.match(metadata.hash, /^[a-f0-9]{64}$/);
    assert.equal(metadata.frontendSource, "devUrl");
    assert.equal(metadata.usesExternalDatabase, false);
  });
});

test("performance fixture table search continues after the first physical page", async () => {
  await withMockLocation("?perfProfile=deterministic-v1&scenario=rows-100k-500-pk", async () => {
    const previousTrace = globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__;
    const trace = [];
    globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__ = trace;
    try {
    resetMockWorkbenchState();
    const [table] = await mockWorkbenchInvoke("list_tables", {
      connectionId: "perf-fixture",
      database: "perf_db",
    });
    const page = await mockWorkbenchInvoke("open_table_session", {
      connectionId: "perf-fixture",
      database: "perf_db",
      tableName: table.table_name,
      options: { page: 1, pageSize: 2 },
    });
    const query = "rows-100k-500-pk|r000129|c001";

    const first = await mockWorkbenchInvoke("begin_table_search", {
      request: { sessionId: page.sessionId, query, mode: "exact", sort: null, resultPageSize: 100 },
    });
    const second = await mockWorkbenchInvoke("next_table_search_page", {
      request: { jobId: first.jobId },
    });

    assert.deepEqual(first.rows, []);
    assert.equal(first.scannedRows, 128);
    assert.equal(first.complete, false);
    assert.equal(second.rows[0].id, "129");
    assert.ok(second.matches.some((match) => match.sourceRowIndex === 128 && match.columnIndex === 1));
    assert.equal(second.scannedRows, 256);
    assert.equal(second.complete, false);
    assert.deepEqual(trace.map((entry) => entry.phase), [
      "begin:start",
      "begin:end",
      "next:start",
      "next:end",
    ]);
    assert.ok(trace.every((entry) => Number.isFinite(entry.at)));
    } finally {
      if (previousTrace === undefined) delete globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__;
      else globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__ = previousTrace;
    }
  });
});

test("performance no-key and schema scenarios keep their exact shapes", async () => {
  await withMockLocation("?perfProfile=deterministic-v1&scenario=rows-100k-40-no-pk", async () => {
    const [table] = await mockWorkbenchInvoke("list_tables", {
      connectionId: "perf-fixture",
      database: "perf_db",
    });
    const page = await mockWorkbenchInvoke("open_table_session", {
      connectionId: "perf-fixture",
      database: "perf_db",
      tableName: table.table_name,
      options: { page: 1, pageSize: 2 },
    });
    assert.deepEqual(page.primaryKeys, []);
    assert.equal(page.columns.length, 40);
  });

  await withMockLocation("?perfProfile=deterministic-v1&scenario=schema-800x60", async () => {
    const tables = await mockWorkbenchInvoke("list_tables", {
      connectionId: "perf-fixture",
      database: "perf_db",
    });
    assert.equal(tables.length, 800);
    assert.ok(tables.every((table) => table.columnCount === 60));

    const selection = await mockWorkbenchInvoke("select_database", {
      connectionId: "perf-fixture",
      database: "perf_db",
    });
    assert.equal(selection.tables.length, 800);
    assert.equal(selection.columnCount, 800 * 60);
    assert.ok(selection.tables.every((table) => table.schemaLoaded && table.columns.length === 60));
  });
});

test("unknown and parameterized performance profiles never alter ordinary mock behavior", async () => {
  for (const search of [
    "?perfProfile=unknown&scenario=rows-100k-500-pk",
    "?perfProfile=deterministic-v1&scenario=rows-100k-500-pk&rows=1",
  ]) {
    await withMockLocation(search, async () => {
      const connections = await mockWorkbenchInvoke("list_connections", {});
      assert.ok(connections.length > 1);
      assert.ok(connections.some((connection) => connection.id === "demo"));
      assert.ok(!connections.some((connection) => connection.id === "perf-fixture"));
    });
  }
});

test("performance fixture reset expires sessions and restarts deterministic session identity", async () => {
  await withMockLocation("?perfProfile=deterministic-v1&scenario=smoke", async () => {
    const [table] = await mockWorkbenchInvoke("list_tables", {
      connectionId: "perf-fixture",
      database: "perf_db",
    });
    const before = await mockWorkbenchInvoke("open_table_session", {
      connectionId: "perf-fixture",
      database: "perf_db",
      tableName: table.table_name,
      options: { page: 1, pageSize: 2 },
    });

    assert.deepEqual(await mockWorkbenchInvoke("perf_fixture_reset", {}), { reset: true });
    await assert.rejects(
      mockWorkbenchInvoke("fetch_table_page", {
        sessionId: before.sessionId,
        request: { page: 2, pageSize: 2 },
      }),
      /fixture session.*expired/i,
    );

    const after = await mockWorkbenchInvoke("open_table_session", {
      connectionId: "perf-fixture",
      database: "perf_db",
      tableName: table.table_name,
      options: { page: 1, pageSize: 2 },
    });
    assert.equal(after.sessionId, "perf-session-1");
  });
});

function collectMockEvents(eventName = "agent-event") {
  const events = [];
  const unlisten = onMockEvent(eventName, (event) => {
    events.push(event.payload);
  });
  return { events, unlisten };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("mock schema can expand demo game_db for large table stress runs", () => {
  const schema = resolveMockSchema("demo", "game_db", { tableCount: 800 });

  assert.equal(schema.length, 800);
  assert.equal(schema[0].table_name, "player");
  assert.match(schema[schema.length - 1].table_name, /^stress_table_/);
  assert.equal(resolveMockSchema("demo-staging", "game_db", { tableCount: 800 }).length, 800);
  assert.notEqual(resolveMockSchema("demo-staging", "analytics_db", { tableCount: 800 }).length, 800);
});

test("mock table pages stay fast and the dedicated count returns no row payload", async () => {
  resetMockDatabaseSchemas();
  const fastPage = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    options: {
      page: 1,
      pageSize: 1,
      includeTotal: false,
    },
  });

  assert.equal(fastPage.rows.length, 1);
  assert.equal(fastPage.totalRows, 1);
  assert.equal(fastPage.totalRowsExact, false);
  assert.equal(fastPage.hasMore, true);

  const exactCount = await mockWorkbenchInvoke("fetch_table_count", {
    sessionId: fastPage.sessionId,
    requestId: "mock-count-1",
    filter: null,
  });

  assert.ok(exactCount.totalRows > fastPage.totalRows);
  assert.equal(exactCount.exact, true);
  assert.equal(exactCount.estimated, false);
  assert.equal("rows" in exactCount, false);
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

test("mock search_values returns multiple matching columns from the same table", async () => {
  const rows = getOrInitRows("demo", "game_db", "hero");
  rows.unshift({
    id: "mock-multi-ice",
    name: "寒冰英雄",
    rarity: "5",
    element: "冰",
    hp_base: "1000",
    atk_base: "120",
    def_base: "80",
    spd_base: "60",
    skill_id: "1",
    passive_id: "2",
    description: "冰霜说明",
    is_available: "1",
  });

  const results = await mockWorkbenchInvoke("search_values", {
    request: {
      connectionId: "demo",
      database: "game_db",
      query: "冰",
      limit: 50,
      priorityTables: ["hero"],
    },
  });
  const heroColumns = results
    .filter((item) => item.tableName === "hero")
    .map((item) => item.columnName);

  assert.ok(heroColumns.includes("name"));
  assert.ok(heroColumns.includes("element"));
  assert.ok(heroColumns.includes("description"));
});

test("mock search_values supports limits above one hundred for wider value scans", async () => {
  const results = await mockWorkbenchInvoke("search_values", {
    request: {
      connectionId: "demo",
      database: "game_db",
      query: "1",
      limit: 180,
    },
  });

  assert.ok(results.length > 100);
  assert.ok(results.length <= 180);
});

test("mock search_values clamps large requests to the 1500-table window", async () => {
  resetMockDatabaseSchemas();
  const tableNames = Array.from({ length: 1600 }, (_, index) => `limit_probe_${index}`);
  try {
    mockDatabaseSchemas["demo/game_db"] = tableNames;
    for (const tableName of tableNames) {
      rowCache.set(`demo/game_db/${tableName}`, [{ id: "1" }]);
    }

    const results = await mockWorkbenchInvoke("search_values", {
      request: {
        connectionId: "demo",
        database: "game_db",
        query: "1",
        limit: 2000,
      },
    });

    assert.equal(results.length, 1500);
  } finally {
    resetMockDatabaseSchemas();
    for (const tableName of tableNames) {
      rowCache.delete(`demo/game_db/${tableName}`);
    }
  }
});

test("mock search_values requires the full query to be contiguous", async () => {
  const rows = getOrInitRows("demo", "game_db", "hero");
  const lateMatch = `${"İ".repeat(90)}21020${"x".repeat(200)}`;
  const fixtures = [
    { id: "mock-separated-value", description: "2,10,20" },
    { id: "mock-contiguous-value", description: lateMatch },
  ];
  rows.unshift(...fixtures);

  try {
    const results = await mockWorkbenchInvoke("search_values", {
      request: {
        connectionId: "demo",
        database: "game_db",
        query: "21020",
        limit: 50,
      },
    });

    const descriptions = results
      .filter((item) => item.tableName === "hero" && item.columnName === "description")
      .map((item) => item.previewValue);
    assert.equal(descriptions.length, 1);
    assert.ok(descriptions[0].length <= 80);
    assert.ok(descriptions[0].includes("21020"));
  } finally {
    for (const fixture of fixtures) {
      const index = rows.findIndex((row) => row.id === fixture.id);
      if (index >= 0) rows.splice(index, 1);
    }
  }
});

test("mock search_values scans priority tables before applying the result limit", async () => {
  const playerRows = getOrInitRows("demo", "game_db", "player");
  playerRows.unshift({
    id: "mock-earlier-priority-probe",
    username: "ordinary_priority_probe",
    nickname: "普通优先探针",
    level: "1",
    class: "mage",
    last_login: "2026-01-01 00:00:00",
    bio: "non-priority fixture",
  });
  const rows = getOrInitRows("demo", "game_db", "hero");
  rows.unshift({
    id: "mock-priority-probe",
    name: "Priority Probe Hero",
    rarity: "5",
    element: "probe",
    hp_base: "1000",
    atk_base: "120",
    def_base: "80",
    spd_base: "60",
    skill_id: "1",
    passive_id: "2",
    description: "优先探针命中",
    is_available: "1",
  });

  const results = await mockWorkbenchInvoke("search_values", {
    request: {
      connectionId: "demo",
      database: "game_db",
      query: "优先探针",
      limit: 1,
      priorityTables: ["hero"],
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].tableName, "hero");
  assert.equal(results[0].previewValue, "优先探针命中");
});

test("mock search_values filters included tables before the 1500-table scan window", async () => {
  resetMockDatabaseSchemas();
  const tableNames = Array.from({ length: 1502 }, (_, index) => `scope_probe_${index}`);
  const includedTable = tableNames.at(-1);
  try {
    mockDatabaseSchemas["demo/game_db"] = tableNames;
    rowCache.set(`demo/game_db/${includedTable}`, [{ id: "scope-only-value" }]);

    const results = await mockWorkbenchInvoke("search_values", {
      request: {
        connectionId: "demo",
        database: "game_db",
        query: "scope-only-value",
        limit: 10,
        includedTables: [includedTable],
      },
    });

    assert.deepEqual(results.map((item) => item.tableName), [includedTable]);
  } finally {
    resetMockDatabaseSchemas();
    rowCache.delete(`demo/game_db/${includedTable}`);
  }
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

test("mock insert and delete operations appear in the audit log with row contents", async () => {
  const connectionId = "mock-row-audit";
  const database = "game_db";
  const tableName = "player";
  const page = await mockWorkbenchInvoke("open_table_session", { connectionId, database, tableName });
  const inserted = { id: "990001", username: "audit-row" };

  await mockWorkbenchInvoke("insert_row", {
    request: { sessionId: page.sessionId, draft: inserted },
  });
  await mockWorkbenchInvoke("delete_rows", {
    request: { sessionId: page.sessionId, rowIdentities: [{ id: inserted.id }] },
  });

  const logs = await mockWorkbenchInvoke("list_audit_logs", {
    request: { connectionId, database, tableName },
  });
  assert.deepEqual(logs.map((entry) => entry.operation), ["DELETE", "INSERT"]);
  assert.deepEqual(JSON.parse(logs[0].oldValue), inserted);
  assert.deepEqual(JSON.parse(logs[1].newValue), inserted);
  assert.deepEqual(logs[0].rowIdentity, { id: inserted.id });
  assert.deepEqual(logs[1].rowIdentity, { id: inserted.id });
});

test("mock import_rows inserts, updates, and keeps unchanged rows", async () => {
  const connectionId = "mock-batch-import-upsert";
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId,
    database: "game_db",
    tableName: "player",
  });
  const existing = page.rows[0];
  const rows = getOrInitRows(connectionId, "game_db", "player");

  const result = await mockWorkbenchInvoke("import_rows", {
    request: {
      sessionId: page.sessionId,
      rows: [
        { ...existing },
        { id: existing.id, username: "batch-updated-user" },
        { ...existing, id: "999998", username: "batch-new-user" },
      ],
    },
  });

  assert.deepEqual(result, {
    inserted: 1,
    updated: 1,
    unchanged: 1,
    errors: [],
    outcomes: [
      { index: 0, status: "unchanged" },
      { index: 1, status: "updated" },
      { index: 2, status: "inserted" },
    ],
  });
  assert.equal(rows.find((row) => row.id === existing.id).username, "batch-updated-user");
  assert.equal(rows.find((row) => row.id === "999998").username, "batch-new-user");
});

test("mock import_rows rejects batches larger than one hundred rows", async () => {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "mock-batch-import-limit",
    database: "game_db",
    tableName: "player",
  });

  await assert.rejects(
    () => mockWorkbenchInvoke("import_rows", {
      request: {
        sessionId: page.sessionId,
        rows: Array.from({ length: 101 }, (_, index) => ({ id: `limit-${index}` })),
      },
    }),
    /100/,
  );
});

test("mock import_rows rejects tables without primary keys", async () => {
  const connectionId = "mock-batch-import-no-primary-key";
  const tableName = "no_primary_key_import_fixture";
  mockTableDefs[tableName] = {
    table_name: tableName,
    table_comment: "",
    columns: [{
      column_name: "text",
      column_type: "varchar(64)",
      column_comment: "",
      is_primary_key: false,
      is_nullable: false,
    }],
  };
  mockDatabaseSchemas[`${connectionId}/game_db`] = [tableName];

  try {
    const page = await mockWorkbenchInvoke("open_table_session", {
      connectionId,
      database: "game_db",
      tableName,
    });

    await assert.rejects(
      () => mockWorkbenchInvoke("import_rows", {
        request: {
          sessionId: page.sessionId,
          rows: [{ text: "unsafe" }],
        },
      }),
      /没有主键/,
    );
  } finally {
    delete mockDatabaseSchemas[`${connectionId}/game_db`];
    delete mockTableDefs[tableName];
    rowCache.delete(`${connectionId}/game_db/${tableName}`);
  }
});

test("mock import_rows reports an invalid row and continues with later rows", async () => {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "mock-batch-import-errors",
    database: "game_db",
    tableName: "player",
  });

  const result = await mockWorkbenchInvoke("import_rows", {
    request: {
      sessionId: page.sessionId,
      rows: [
        { ...page.rows[0], id: "" },
        { ...page.rows[0], id: "999999", username: "valid" },
      ],
    },
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].index, 0);
  assert.equal(result.errors[0].columnName, "id");
  assert.deepEqual(result.outcomes.map((item) => item.status), ["error", "inserted"]);
});

test("mock import_rows ignores unknown and primary-key fields when updating", async () => {
  const connectionId = "mock-batch-import-update-fields";
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId,
    database: "game_db",
    tableName: "player",
  });
  const existing = page.rows[0];
  const rows = getOrInitRows(connectionId, "game_db", "player");

  const result = await mockWorkbenchInvoke("import_rows", {
    request: {
      sessionId: page.sessionId,
      rows: [{ id: existing.id, unknown_column: "ignored" }],
    },
  });

  assert.equal(result.unchanged, 1);
  assert.equal(result.updated, 0);
  assert.equal(Object.hasOwn(rows[0], "unknown_column"), false);
});

test("mock update_cell rejects duplicate primary keys", async () => {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
  });

  await assert.rejects(
    () => mockWorkbenchInvoke("update_cell", {
      request: {
        sessionId: page.sessionId,
        rowIdentity: { id: "1" },
        columnName: "id",
        oldValue: "1",
        newValue: "2",
      },
    }),
    /主键重复/,
  );
});

function tableSource(name) {
  return {
    connectionId: `mock-design-${name}`,
    database: `game_db_${name}`,
    tableName: "player",
  };
}

function draftFromDesign(design) {
  return normalizeTableDesign(design);
}

test("get_table_design returns design metadata for a known table", async () => {
  const design = await mockWorkbenchInvoke("get_table_design", {
    connection_id: "demo",
    database: "game_db",
    tableName: "player",
  });

  assert.equal(design.table_name, "player");
  assert.equal(design.tableName, "player");
  assert.equal(design.table_comment, "玩家账号表");
  assert.equal(design.tableComment, "玩家账号表");
  assert.ok(design.columns.length > 0);
  assert.deepEqual(
    Object.keys(design.columns[0]).filter((key) => [
      "column_name",
      "column_type",
      "data_type",
      "is_nullable",
      "is_primary_key",
      "column_default",
      "column_comment",
      "original_name",
      "original_type",
    ].includes(key)).sort(),
    [
      "column_comment",
      "column_default",
      "column_name",
      "column_type",
      "data_type",
      "is_nullable",
      "is_primary_key",
      "original_name",
      "original_type",
    ].sort(),
  );
  const username = design.columns.find((column) => column.column_name === "username");
  assert.equal(username.column_type, "varchar(32)");
  assert.equal(username.data_type, "varchar");
  assert.equal(username.character_maximum_length, 32);
  assert.equal(username.column_comment, "用户名");
});

test("preview_table_design_change accepts UI rename payloads built from normalized design", async () => {
  const source = tableSource("ui-rename-preview");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const username = draft.columns.find((column) => column.name === "username");
  username.name = "login_name";
  const payload = buildTableDesignPayload(source, draft);

  const preview = await mockWorkbenchInvoke("preview_table_design_change", payload);

  assert.equal(preview.hasChanges, true);
  assert.ok(preview.statements.some((statement) => statement.includes("CHANGE COLUMN `username` `login_name`")));
});

test("apply_table_design_change accepts UI rename payloads and updates mock row keys", async () => {
  const source = tableSource("ui-rename-apply");
  const pageBefore = await mockWorkbenchInvoke("open_table_session", source);
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const username = draft.columns.find((column) => column.name === "username");
  username.name = "login_name";
  const payload = buildTableDesignPayload(source, draft);
  const preview = await mockWorkbenchInvoke("preview_table_design_change", payload);

  await mockWorkbenchInvoke("apply_table_design_change", {
    ...payload,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const schema = await mockWorkbenchInvoke("get_table_schema", source);
  const pageAfter = await mockWorkbenchInvoke("open_table_session", source);

  assert.ok(schema.columns.some((column) => column.column_name === "login_name"));
  assert.equal(pageAfter.rows[0].login_name, pageBefore.rows[0].username);
  assert.ok(!Object.prototype.hasOwnProperty.call(pageAfter.rows[0], "username"));
});

test("preview_table_design_change returns SQL and signatures without mutating schema", async () => {
  const source = tableSource("preview");
  const before = await mockWorkbenchInvoke("get_table_schema", source);
  const draft = draftFromDesign(before);
  draft.tableComment = "玩家账号表 - preview only";
  draft.columns[1].name = "login_name";
  draft.columns[1].length = "48";
  draft.columns[1].comment = "登录名";
  draft.columns[2].primaryKey = true;

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });
  const after = await mockWorkbenchInvoke("get_table_schema", source);

  assert.equal(preview.hasChanges, true);
  assert.match(preview.previewSignature, /^mock-preview:/);
  assert.match(preview.signature, /^mock-preview:/);
  assert.match(preview.schemaSignature, /^mock-schema:/);
  assert.match(preview.sourceSignature, /^mock-schema:/);
  assert.ok(preview.statements.some((statement) => statement.includes("ALTER TABLE `player` COMMENT = '玩家账号表 - preview only'")));
  assert.ok(preview.statements.some((statement) => statement.includes("CHANGE COLUMN `username` `login_name` varchar(48) NOT NULL COMMENT '登录名'")));
  assert.ok(preview.statements.some((statement) => statement.includes("DROP PRIMARY KEY")));
  assert.ok(preview.statements.some((statement) => statement.includes("ADD PRIMARY KEY (`id`, `nickname`)")));
  assert.deepEqual(after, before);
});

test("preview_table_design_change reports text to integer conflicts", async () => {
  const source = tableSource("type-conflict-preview");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const username = draft.columns.find((column) => column.name === "username");
  username.type = "int";
  username.length = "11";
  username.scale = "";

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  assert.equal(preview.hasChanges, true);
  assert.ok(preview.conflicts.some((conflict) => /username|int|整数/i.test(conflict)), `conflicts were ${preview.conflicts}`);
});

test("apply_table_design_change rejects conflicting previews before mutating schema", async () => {
  const source = tableSource("type-conflict-apply");
  const before = await mockWorkbenchInvoke("get_table_schema", source);
  const draft = draftFromDesign(before);
  const username = draft.columns.find((column) => column.name === "username");
  username.type = "int";
  username.length = "11";
  username.scale = "";
  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  await assert.rejects(
    () => mockWorkbenchInvoke("apply_table_design_change", {
      ...source,
      draft,
      previewSignature: preview.previewSignature,
      schemaSignature: preview.schemaSignature,
    }),
    /conflict|冲突|无法保存/i,
  );
  const after = await mockWorkbenchInvoke("get_table_schema", source);

  assert.deepEqual(after, before);
});

test("apply_table_design_change mutates schema and refreshed pages use updated metadata", async () => {
  const source = tableSource("apply");
  const design = await mockWorkbenchInvoke("get_table_design", source);
  const draft = draftFromDesign(design);
  draft.tableComment = "玩家账号表 - applied";
  draft.columns[1].name = "login_name";
  draft.columns[1].length = "48";
  draft.columns[1].nullable = true;
  draft.columns[1].defaultMode = "value";
  draft.columns[1].defaultValue = "guest";
  draft.columns[1].comment = "登录名";
  draft.columns[2].primaryKey = true;

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });
  const result = await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const schema = await mockWorkbenchInvoke("get_table_schema", source);
  const page = await mockWorkbenchInvoke("open_table_session", source);

  assert.equal(result.applied, true);
  assert.deepEqual(result.statements, preview.statements);
  assert.equal(result.schema.table_comment, "玩家账号表 - applied");
  assert.equal(schema.table_comment, "玩家账号表 - applied");
  assert.equal(schema.tableComment, "玩家账号表 - applied");
  const loginName = schema.columns.find((column) => column.column_name === "login_name");
  assert.equal(loginName.column_type, "varchar(48)");
  assert.equal(loginName.is_nullable, true);
  assert.equal(loginName.column_default, "guest");
  assert.equal(loginName.column_comment, "登录名");
  assert.deepEqual(schema.columns.filter((column) => column.is_primary_key).map((column) => column.column_name), ["id", "nickname"]);
  assert.equal(page.tableComment, "玩家账号表 - applied");
  assert.ok(page.columns.some((column) => column.column_name === "login_name"));
  assert.deepEqual(page.primaryKeys, ["id", "nickname"]);
});

test("applying a column rename updates existing mock row keys", async () => {
  const source = tableSource("rename-rows");
  const pageBefore = await mockWorkbenchInvoke("open_table_session", source);
  assert.ok(Object.prototype.hasOwnProperty.call(pageBefore.rows[0], "username"));

  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns[1].name = "login_name";
  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });
  await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const pageAfter = await mockWorkbenchInvoke("open_table_session", source);

  assert.equal(pageAfter.rows[0].login_name, pageBefore.rows[0].username);
  assert.ok(!Object.prototype.hasOwnProperty.call(pageAfter.rows[0], "username"));
});

test("applying a mock column rename resets the next design baseline", async () => {
  const source = tableSource("rename-baseline");
  const firstDraft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  firstDraft.columns[0].name = "id_browser_test";
  const firstPreview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft: firstDraft });
  await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft: firstDraft,
    previewSignature: firstPreview.previewSignature,
    schemaSignature: firstPreview.schemaSignature,
  });

  const secondDraft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  secondDraft.columns[0].name = "id";
  const secondPreview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft: secondDraft });

  assert.ok(secondPreview.statements.some((statement) => statement.includes("CHANGE COLUMN `id_browser_test` `id`")));
});

test("swapping two column names preserves both original mock row values", async () => {
  const source = tableSource("swap-rows");
  const pageBefore = await mockWorkbenchInvoke("open_table_session", source);
  const beforeRow = pageBefore.rows[0];
  assert.notEqual(beforeRow.username, beforeRow.nickname);

  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns[1].name = "nickname";
  draft.columns[2].name = "username";
  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });
  await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const pageAfter = await mockWorkbenchInvoke("open_table_session", source);
  const afterRow = pageAfter.rows[0];

  assert.equal(afterRow.nickname, beforeRow.username);
  assert.equal(afterRow.username, beforeRow.nickname);
});

test("table design overrides are isolated by connection and database", async () => {
  const editedSource = tableSource("isolated-edited");
  const untouchedSource = { ...editedSource, connectionId: "mock-design-isolated-untouched" };
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", editedSource));
  draft.tableComment = "isolated edited comment";
  draft.columns[1].name = "login_name";

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...editedSource, draft });
  await mockWorkbenchInvoke("apply_table_design_change", {
    ...editedSource,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const editedSchema = await mockWorkbenchInvoke("get_table_schema", editedSource);
  const untouchedSchema = await mockWorkbenchInvoke("get_table_schema", untouchedSource);

  assert.equal(editedSchema.table_comment, "isolated edited comment");
  assert.ok(editedSchema.columns.some((column) => column.column_name === "login_name"));
  assert.equal(untouchedSchema.table_comment, "玩家账号表");
  assert.ok(untouchedSchema.columns.some((column) => column.column_name === "username"));
});

test("preview_table_design_change supports drafts that remove existing columns", async () => {
  const source = tableSource("missing-column");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const omittedName = draft.columns[2].name;
  draft.columns.splice(2, 1);

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  assert.ok(preview.statements.some((statement) => statement.includes(`DROP COLUMN \`${omittedName}\``)));
  assert.ok(preview.humanDescriptions.some((description) => description.includes("删除字段") && description.includes(omittedName)));
});

test("apply_table_design_change removes columns from mock schema and rows", async () => {
  const source = tableSource("removed-column-apply");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const removedName = draft.columns[2].name;
  draft.columns.splice(2, 1);
  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const schema = await mockWorkbenchInvoke("get_table_schema", source);
  const page = await mockWorkbenchInvoke("open_table_session", source);

  assert.ok(!schema.columns.some((column) => column.column_name === removedName));
  assert.ok(!Object.prototype.hasOwnProperty.call(page.rows[0], removedName));
});

test("preview_table_design_change supports normalized drafts with added columns", async () => {
  const source = tableSource("added-column-preview");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns.push({
    id: "draft-bonus-score",
    originalName: "",
    name: "bonus_score",
    type: "int",
    length: "",
    scale: "",
    originalType: "int",
    nullable: true,
    primaryKey: false,
    defaultMode: "none",
    defaultValue: "",
    comment: "",
  });

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  assert.equal(preview.hasChanges, true);
  assert.ok(preview.statements.some((statement) => statement.includes("ADD COLUMN `bonus_score` int NULL")));
});

test("preview_table_design_change diffs inserted columns by originalName instead of index", async () => {
  const source = tableSource("added-column-middle-preview");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns.splice(1, 0, {
    id: "draft-bonus-score-middle",
    originalName: "",
    name: "bonus_score",
    type: "int",
    length: "",
    scale: "",
    originalType: "int",
    nullable: true,
    primaryKey: false,
    defaultMode: "none",
    defaultValue: "",
    comment: "",
  });

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });
  const joined = preview.statements.join("\n");

  assert.match(joined, /ADD COLUMN `bonus_score` int NULL/);
  assert.doesNotMatch(joined, /CHANGE COLUMN `username` `bonus_score`/);
  assert.doesNotMatch(joined, /CHANGE COLUMN `nickname` `username`/);
});

test("apply_table_design_change applies normalized drafts with added columns", async () => {
  const source = tableSource("added-column-apply");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns.push({
    id: "draft-bonus-score",
    originalName: "",
    name: "bonus_score",
    type: "int",
    length: "",
    scale: "",
    originalType: "int",
    nullable: true,
    primaryKey: false,
    defaultMode: "none",
    defaultValue: "",
    comment: "",
  });
  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const schema = await mockWorkbenchInvoke("get_table_schema", source);
  const page = await mockWorkbenchInvoke("open_table_session", source);

  assert.ok(schema.columns.some((column) => column.column_name === "bonus_score"));
  assert.ok(Object.prototype.hasOwnProperty.call(page.rows[0], "bonus_score"));
});

test("expression defaults preview unquoted and remain expression defaults after apply", async () => {
  const source = tableSource("expression-default");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const createTime = draft.columns.find((column) => column.name === "create_time");
  createTime.defaultMode = "expression";
  createTime.defaultValue = "CURRENT_TIMESTAMP";

  const preview = await mockWorkbenchInvoke("preview_table_design_change", { ...source, draft });

  assert.ok(preview.statements.some((statement) => statement.includes("`create_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP")));
  assert.ok(!preview.statements.some((statement) => statement.includes("DEFAULT 'CURRENT_TIMESTAMP'")));

  await mockWorkbenchInvoke("apply_table_design_change", {
    ...source,
    draft,
    previewSignature: preview.previewSignature,
    schemaSignature: preview.schemaSignature,
  });
  const design = normalizeTableDesign(await mockWorkbenchInvoke("get_table_design", source));
  const appliedCreateTime = design.columns.find((column) => column.name === "create_time");

  assert.equal(appliedCreateTime.defaultMode, "expression");
  assert.equal(appliedCreateTime.defaultValue, "CURRENT_TIMESTAMP");
});

test("apply_table_design_change rejects preview signatures from another source", async () => {
  const sourceA = tableSource("signature-source-a");
  const sourceB = tableSource("signature-source-b");
  const draftA = draftFromDesign(await mockWorkbenchInvoke("get_table_design", sourceA));
  draftA.tableComment = "source A preview only";
  const previewA = await mockWorkbenchInvoke("preview_table_design_change", { ...sourceA, draft: draftA });

  const draftB = draftFromDesign(await mockWorkbenchInvoke("get_table_design", sourceB));
  draftB.tableComment = "source A preview only";

  await assert.rejects(
    () => mockWorkbenchInvoke("apply_table_design_change", {
      ...sourceB,
      draft: draftB,
      previewSignature: previewA.previewSignature,
      schemaSignature: previewA.schemaSignature,
    }),
    /stale|mismatch|source/i,
  );
});

test("apply_table_design_change rejects requests without preview signatures", async () => {
  const source = tableSource("missing-preview");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.tableComment = "missing preview should not apply";

  await assert.rejects(
    () => mockWorkbenchInvoke("apply_table_design_change", { ...source, draft }),
    /preview.*signature|签名/i,
  );
});

test("mock preview_database_sync plans copied, removed, and excluded tables deterministically", async () => {
  const preview = await mockWorkbenchInvoke("preview_database_sync", {
    connectionId: "demo-staging",
    sourceDatabase: "analytics_db",
    targetDatabase: "game_db",
    excludedTables: ["event_log"],
  });

  assert.equal(preview.status, "ready");
  assert.deepEqual(
    preview.tables.map((table) => table.name).slice(0, 3),
    ["daily_active_user", "revenue_report", "retention_cohort"],
  );
  assert.deepEqual(
    preview.tables.filter((table) => table.action === "copy").map((table) => table.name),
    ["daily_active_user", "revenue_report", "retention_cohort", "ab_test_config"],
  );
  assert.deepEqual(preview.excludedTables, ["event_log"]);
  assert.deepEqual(preview.tables.filter((table) => table.action === "preserve-excluded"), []);
  assert.ok(preview.tables.some((table) => table.name === "player" && table.action === "remove"));
  assert.ok(!preview.tables.some((table) => table.name === "event_log"));
});

test("mock preview_database_sync ignores exclusions that are not source tables", async () => {
  const preview = await mockWorkbenchInvoke("preview_database_sync", {
    connectionId: "demo-staging",
    sourceDatabase: "analytics_db",
    targetDatabase: "game_db",
    excludedTables: ["player", "event_log"],
  });

  assert.deepEqual(preview.excludedTables, ["event_log"]);
  assert.ok(preview.tables.some((table) => table.name === "player" && table.action === "remove"));
  assert.ok(!preview.tables.some((table) => table.name === "event_log"));
  assert.ok(preview.warnings.some((warning) => warning.includes("player")));
});

test("mock sync_database_overwrite preserves excluded source table names in the target", async () => {
  const connectionId = "demo";
  const sourceDatabase = "game_config";
  const targetDatabase = "game_db";
  const excludedRows = getOrInitRows(connectionId, targetDatabase, "hero");
  const originalExcludedFirstRow = { ...excludedRows[0] };
  const sourceFeatureRows = getOrInitRows(connectionId, sourceDatabase, "feature_flag");
  const sourceFeatureFirstRow = { ...sourceFeatureRows[0] };
  const progressEvents = [];
  const unlisten = onMockEvent("database-sync-progress", ({ payload }) => progressEvents.push(payload));

  const result = await mockWorkbenchInvoke("sync_database_overwrite", {
    connectionId,
    sourceDatabase,
    targetDatabase,
    excludedTables: ["hero"],
    jobId: "mock-sync-test",
  });
  unlisten();

  assert.equal(result.status, "succeeded");
  assert.match(result.message, /一致性校验通过/);
  assert.equal(result.jobId, "mock-sync-test");
  assert.deepEqual(result.preservedTables, ["hero"]);
  assert.deepEqual(result.copiedTables, ["item", "equip", "skill", "config_entry", "localization", "version_info", "feature_flag"]);
  assert.ok(result.droppedTables.includes("player"));
  assert.deepEqual(getOrInitRows(connectionId, targetDatabase, "hero")[0], originalExcludedFirstRow);
  assert.deepEqual(getOrInitRows(connectionId, targetDatabase, "feature_flag")[0], sourceFeatureFirstRow);
  assert.deepEqual(
    resolveMockSchema(connectionId, targetDatabase).map((table) => table.table_name),
    ["item", "equip", "skill", "config_entry", "localization", "version_info", "feature_flag", "hero"],
  );
  assert.ok(progressEvents.some((event) => event.stage === "verify"));
  assert.ok(progressEvents.some((event) => event.stage === "completed" && event.status === "succeeded"));
});

test("mock database sync exposes the cancel command contract", async () => {
  assert.deepEqual(await mockWorkbenchInvoke("cancel_database_sync", { jobId: "missing" }), {
    cancelled: false,
  });
});

test("mock database sync mutations reset to the initial browser fixture", async () => {
  const connectionId = "demo-staging";
  const sourceDatabase = "analytics_db";
  const targetDatabase = "game_db";

  await mockWorkbenchInvoke("sync_database_overwrite", {
    connectionId,
    sourceDatabase,
    targetDatabase,
    excludedTables: [],
    jobId: "mock-reset-test",
  });

  assert.deepEqual(
    resolveMockSchema(connectionId, targetDatabase).map((table) => table.table_name),
    ["event_log", "daily_active_user", "revenue_report", "retention_cohort", "ab_test_config"],
  );

  resetMockDatabaseSchemas();

  assert.ok(resolveMockSchema(connectionId, targetDatabase).some((table) => table.table_name === "player"));
  assert.ok(resolveMockSchema(connectionId, targetDatabase).some((table) => table.table_name === "staging_flag"));
});

test("mock agent plan requests stay actionable and finish after approval", async () => {
  const { events, unlisten } = collectMockEvents();
  try {
    await mockWorkbenchInvoke("agent_start_session", {
      context: { connectionId: "demo", database: "game_db", activeTableName: "player" },
      config: { permissionMode: "plan" },
    });
    await mockWorkbenchInvoke("agent_send", {
      text: "给我一个修改 player 的计划",
      context: { connectionId: "demo", database: "game_db", activeTableName: "player" },
    });
    await wait(240);

    const plan = events.find((event) => event.ev === "plan");
    assert.ok(plan?.req_id, "expected mock plan request");
    assert.match(plan.text, /执行计划/);
    assert.equal(events.some((event) => event.ev === "result"), false);

    await mockWorkbenchInvoke("agent_approve_tool", { req_id: plan.req_id });
    await wait(80);

    assert.ok(events.some((event) => event.ev === "text_delta" && /批准/.test(event.text || "")));
    assert.ok(events.some((event) => event.ev === "result" && event.subtype === "success"));
  } finally {
    unlisten();
  }
});

test("mock agent write approval requests finish after denial", async () => {
  const { events, unlisten } = collectMockEvents();
  try {
    await mockWorkbenchInvoke("agent_start_session", {
      context: { connectionId: "demo", database: "game_db", activeTableName: "player" },
      config: { permissionMode: "default" },
    });
    await mockWorkbenchInvoke("agent_send", {
      text: "把 id 为 1 的玩家昵称改成 Admin",
      context: { connectionId: "demo", database: "game_db", activeTableName: "player" },
    });
    await wait(240);

    const approval = events.find((event) => event.ev === "approval_request");
    assert.ok(approval?.req_id, "expected mock approval request");
    assert.match(approval.input.sql, /UPDATE player/);

    await mockWorkbenchInvoke("agent_deny_tool", { req_id: approval.req_id, message: "先别改" });
    await wait(80);

    assert.ok(events.some((event) => event.ev === "text_delta" && /已取消/.test(event.text || "")));
    assert.ok(events.some((event) => event.ev === "result" && event.subtype === "success"));
  } finally {
    unlisten();
  }
});

test("mock agent can request opening a table in the workbench", async () => {
  const { events, unlisten } = collectMockEvents();
  try {
    await mockWorkbenchInvoke("agent_start_session", {
      context: { connectionId: "demo", database: "game_db", activeTableName: "player" },
      config: { permissionMode: "default" },
    });
    await mockWorkbenchInvoke("agent_send", {
      text: "打开 hero 表",
      context: { connectionId: "demo", database: "game_db", activeTableName: "player" },
    });
    await wait(240);

    const action = events.find((event) => event.ev === "workbench_action");
    assert.ok(action, "expected a workbench action event");
    assert.equal(action.action, "open_table");
    assert.equal(action.connectionId, "demo");
    assert.equal(action.database, "game_db");
    assert.equal(action.tableName, "hero");
    assert.ok(events.some((event) => event.ev === "tool_use" && event.name === "open_table"));
    assert.ok(events.some((event) => event.ev === "result" && event.subtype === "success"));
  } finally {
    unlisten();
  }
});

test("list_tables includes column counts for homepage object metadata", async () => {
  resetMockDatabaseSchemas();
  const connectionId = "demo";
  const database = "game_db";

  const tables = await mockWorkbenchInvoke("list_tables", { connectionId, database });
  const player = tables.find((table) => table.table_name === "player");
  const schema = await mockWorkbenchInvoke("get_table_schema", { connectionId, database, tableName: "player" });

  assert.equal(player.column_count, schema.columns.length);
  assert.equal(player.columnCount, schema.columns.length);
  assert.ok(player.data_size_bytes > 0);
  assert.match(player.modified_at, /^2026-07-/);

  resetMockDatabaseSchemas();
});

test("rename_table preserves full column definitions when no schema override exists", async () => {
  resetMockDatabaseSchemas();
  const connectionId = "demo";
  const database = "game_db";
  const oldName = "player";
  const newName = "player_renamed";

  const schemaBefore = await mockWorkbenchInvoke("get_table_schema", {
    connectionId,
    database,
    tableName: oldName,
  });
  const columnCountBefore = schemaBefore.columns.length;
  assert.ok(columnCountBefore > 1, "player should have more than just an id column");

  const result = await mockWorkbenchInvoke("rename_table", {
    connectionId,
    database,
    tableName: oldName,
    newName,
  });

  assert.equal(result.renamed, true);
  assert.equal(result.from, oldName);
  assert.equal(result.to, newName);

  // Verify the renamed table appears in the schema list
  const tables = await mockWorkbenchInvoke("list_tables", { connectionId, database });
  const tableNames = tables.map((t) => t.table_name || t.tableName);
  assert.ok(tableNames.includes(newName), "new table name should appear in list_tables");
  assert.ok(!tableNames.includes(oldName), "old table name should not appear in list_tables");

  // Verify column definitions are preserved (not a fallback with only "id")
  const schemaAfter = await mockWorkbenchInvoke("get_table_schema", {
    connectionId,
    database,
    tableName: newName,
  });
  assert.equal(schemaAfter.columns.length, columnCountBefore, "column count should be preserved");
  assert.ok(
    schemaAfter.columns.some((c) => c.column_name === "username"),
    "renamed table should still have the username column"
  );

  resetMockDatabaseSchemas();
});

test("rename_table preserves row data after rename", async () => {
  resetMockDatabaseSchemas();
  const connectionId = "demo";
  const database = "game_db";
  const oldName = "player";
  const newName = "player_renamed";

  // Open a session before rename to get rows
  const pageBefore = await mockWorkbenchInvoke("open_table_session", {
    connectionId,
    database,
    tableName: oldName,
  });
  const rowCountBefore = pageBefore.rows.length;

  // Rename the table
  await mockWorkbenchInvoke("rename_table", {
    connectionId,
    database,
    tableName: oldName,
    newName,
  });

  // Open a session with the new name
  const pageAfter = await mockWorkbenchInvoke("open_table_session", {
    connectionId,
    database,
    tableName: newName,
  });

  assert.equal(pageAfter.rows.length, rowCountBefore, "row count should be preserved after rename");
  // Verify row structure is preserved (should have username column, not just id)
  assert.ok(
    Object.prototype.hasOwnProperty.call(pageAfter.rows[0], "username"),
    "rows should still have username column after rename"
  );

  resetMockDatabaseSchemas();
});

test("rename_table preserves schema override after rename", async () => {
  resetMockDatabaseSchemas();
  const connectionId = "demo";
  const database = "game_db";
  const oldName = "player";
  const newName = "player_renamed";

  // First apply a design change to create a schema override
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", {
    connectionId,
    database,
    tableName: oldName,
  }));
  draft.tableComment = "renamed table preserve schema";
  draft.columns[1].name = "login_name";
  const preview = await mockWorkbenchInvoke("preview_table_design_change", {
    connectionId,
    database,
    tableName: oldName,
    draft,
  });
  await mockWorkbenchInvoke("apply_table_design_change", {
    connectionId,
    database,
    tableName: oldName,
    draft,
    schemaSignature: preview.schemaSignature,
    previewSignature: preview.previewSignature,
  });

  // Now rename
  await mockWorkbenchInvoke("rename_table", {
    connectionId,
    database,
    tableName: oldName,
    newName,
  });

  // Verify: the overridden schema should be accessible under the new name
  const schemaAfter = await mockWorkbenchInvoke("get_table_schema", {
    connectionId,
    database,
    tableName: newName,
  });
  assert.ok(schemaAfter.columns.length > 1, "renamed table should have full column definitions");
  assert.ok(
    schemaAfter.columns.some((c) => c.column_name === "login_name"),
    "renamed table should preserve the column rename from the override"
  );

  resetMockDatabaseSchemas();
});

test("rename_table rejects duplicate table names", async () => {
  resetMockDatabaseSchemas();
  const connectionId = "demo";
  const database = "game_db";

  await assert.rejects(
    mockWorkbenchInvoke("rename_table", {
      connectionId,
      database,
      tableName: "player",
      newName: "hero",
    }),
    /已存在/,
  );

  resetMockDatabaseSchemas();
});

test("copy_tables starts duplicate table names at copy1", async () => {
  resetMockDatabaseSchemas();
  const result = await mockWorkbenchInvoke("copy_tables", {
    connectionId: "demo",
    sourceDatabase: "game_db",
    targetConnectionId: "demo",
    targetDatabase: "game_db",
    tableNames: ["player"],
  });

  assert.deepEqual(result.copied, [{ originalName: "player", targetName: "player_copy1" }]);
  const tables = await mockWorkbenchInvoke("list_tables", { connectionId: "demo", database: "game_db" });
  const tableNames = tables.map((table) => table.table_name);
  assert.ok(tableNames.includes("player_copy1"), "copied table should be listed under the generated copy name");
  assert.equal(tableNames.filter((name) => name === "player").length, 1, "source table should not be duplicated under its original name");

  resetMockDatabaseSchemas();
});

test("drop_tables removes schema metadata and rows from the mock database", async () => {
  resetMockDatabaseSchemas();
  await mockWorkbenchInvoke("copy_tables", {
    connectionId: "demo",
    sourceDatabase: "game_db",
    targetConnectionId: "demo",
    targetDatabase: "game_db",
    tableNames: ["player", "hero"],
  });
  const copiedRows = getOrInitRows("demo", "game_db", "player_copy1");
  const secondCopiedRows = getOrInitRows("demo", "game_db", "hero_copy1");
  assert.ok(copiedRows.length > 0, "copied table should have rows before drop");
  assert.ok(secondCopiedRows.length > 0, "second copied table should have rows before drop");

  const result = await mockWorkbenchInvoke("drop_tables", {
    connectionId: "demo",
    database: "game_db",
    tables: ["player_copy1", "hero_copy1"],
  });

  assert.deepEqual(result.dropped, [
    { tableName: "player_copy1" },
    { tableName: "hero_copy1" },
  ]);
  assert.deepEqual(result.failed, []);
  const tables = await mockWorkbenchInvoke("list_tables", { connectionId: "demo", database: "game_db" });
  assert.ok(!tables.some((table) => (table.table_name || table.tableName) === "player_copy1"));
  assert.ok(!tables.some((table) => (table.table_name || table.tableName) === "hero_copy1"));
  assert.equal(rowCache.has("demo/game_db/player_copy1"), false);
  assert.equal(rowCache.has("demo/game_db/hero_copy1"), false);

  resetMockDatabaseSchemas();
});

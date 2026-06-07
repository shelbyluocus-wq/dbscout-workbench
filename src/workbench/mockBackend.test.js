import test from "node:test";
import assert from "node:assert/strict";
import { mockWorkbenchInvoke } from "./mock/mockBackend.js";
import { getOrInitRows } from "./mock/mockRows.js";
import { resolveMockSchema } from "./mock/mockSchema.js";
import { buildTableDesignPayload, normalizeTableDesign } from "./utils/tableDesign.js";

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
  assert.ok(preview.statements.some((statement) => statement.includes("DROP PRIMARY KEY, ADD PRIMARY KEY (`id`, `nickname`)")));
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

test("preview_table_design_change rejects drafts that omit existing columns", async () => {
  const source = tableSource("missing-column");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  const omittedName = draft.columns[2].name;
  draft.columns.splice(2, 1);

  await assert.rejects(
    () => mockWorkbenchInvoke("preview_table_design_change", { ...source, draft }),
    new RegExp(`missing.*${omittedName}|omitted.*${omittedName}|drop`, "i"),
  );
});

test("preview_table_design_change rejects normalized drafts with added columns", async () => {
  const source = tableSource("added-column-preview");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns.push({
    id: "draft-bonus-score",
    originalName: "bonus_score",
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

  await assert.rejects(
    () => mockWorkbenchInvoke("preview_table_design_change", { ...source, draft }),
    /adding.*dropping.*bonus_score|add.*drop.*bonus_score/i,
  );
});

test("apply_table_design_change rejects normalized drafts with added columns before applying", async () => {
  const source = tableSource("added-column-apply");
  const draft = draftFromDesign(await mockWorkbenchInvoke("get_table_design", source));
  draft.columns.push({
    id: "draft-bonus-score",
    originalName: "bonus_score",
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

  await assert.rejects(
    () => mockWorkbenchInvoke("apply_table_design_change", {
      ...source,
      draft,
      previewSignature: "mock-preview:added-column",
      schemaSignature: "mock-schema:added-column",
    }),
    /adding.*dropping.*bonus_score|add.*drop.*bonus_score/i,
  );
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

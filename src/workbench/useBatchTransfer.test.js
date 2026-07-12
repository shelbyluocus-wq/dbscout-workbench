import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { useBatchTransfer } from "./composables/useBatchTransfer.js";

function createWorkbookFile(workbook, fileName = "batch.xlsx") {
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  return {
    name: fileName,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function successfulImportRows(payload, overrides = {}) {
  const rowCount = payload?.request?.rows?.length || 0;
  return {
    inserted: rowCount,
    updated: 0,
    unchanged: 0,
    errors: [],
    outcomes: [],
    ...overrides,
  };
}

test("batch export writes selected tables into one workbook", async () => {
  const calls = [];
  const statusText = { value: "" };
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        const tableName = payload.tableName;
        return {
          sessionId: `session-${tableName}`,
          tableName,
          tableComment: "",
          columns: [{ column_name: "id" }, { column_name: "name" }],
          primaryKeys: ["id"],
          rows: [{ id: tableName === "player" ? "1" : "2", name: tableName === "player" ? "Ada" : "Core" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_file") return "C:/exports/game_db-tables.xlsx";
      if (command === "close_table_session") return { closed: true };
      throw new Error(`unexpected command ${command}`);
    },
    statusText,
  });

  transfer.openBatchExport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }],
  });

  await transfer.executeBatchExport();

  const openCalls = calls.filter((call) => call.command === "open_table_session");
  assert.deepEqual(openCalls.map((call) => call.payload.tableName), ["player", "guild"]);
  assert.equal(openCalls[0].payload.options.pageSize, 10000);

  const saveCall = calls.find((call) => call.command === "save_export_file");
  assert.equal(saveCall.payload.fileName, "game_db-tables.xlsx");
  const workbook = XLSX.read(Uint8Array.from(saveCall.payload.data), { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["player", "guild"]);
  assert.equal(workbook.Sheets.player.A2.v, "1");
  assert.equal(workbook.Sheets.guild.B2.v, "Core");
  assert.match(statusText.value, /批量导出完成/);
  assert.deepEqual(
    calls.filter((call) => call.command === "close_table_session").map((call) => call.payload.sessionId),
    ["session-player", "session-guild"],
  );
});

test("batch export adds one field comments sheet per table to a combined workbook when selected", async () => {
  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        return {
          sessionId: `session-${payload.tableName}`,
          tableName: payload.tableName,
          columns: [
            {
              column_name: "id",
              column_type: "bigint",
              is_nullable: false,
              is_primary_key: true,
              column_default: null,
              column_comment: `${payload.tableName} ID`,
            },
            {
              column_name: "name",
              column_type: "varchar(32)",
              is_nullable: true,
              is_primary_key: false,
              column_default: "",
              column_comment: "显示名称",
            },
          ],
          rows: [{ id: "1", name: "Ada" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_file") return "C:/exports/game_db-tables.xlsx";
      if (command === "close_table_session") return { closed: true };
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchExport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }],
  });
  transfer.setBatchExportIncludeColumnComments(true);

  const result = await transfer.executeBatchExport();

  const saveCall = calls.find((call) => call.command === "save_export_file");
  const workbook = XLSX.read(Uint8Array.from(saveCall.payload.data), { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["player", "player字段备注", "guild", "guild字段备注"]);
  assert.deepEqual(
    XLSX.utils.sheet_to_json(workbook.Sheets["player字段备注"], { header: 1, defval: "" }),
    [
      ["表名", "字段名", "字段类型", "可为空", "主键", "默认值", "字段备注"],
      ["player", "id", "bigint", "否", "是", "", "player ID"],
      ["player", "name", "varchar(32)", "是", "否", "", "显示名称"],
    ],
  );
  assert.deepEqual(
    XLSX.utils.sheet_to_json(workbook.Sheets["guild字段备注"], { header: 1, defval: "" }),
    [
      ["表名", "字段名", "字段类型", "可为空", "主键", "默认值", "字段备注"],
      ["guild", "id", "bigint", "否", "是", "", "guild ID"],
      ["guild", "name", "varchar(32)", "是", "否", "", "显示名称"],
    ],
  );
  assert.equal(result.tableCount, 2);
});

test("batch export can write each table into a separate workbook", async () => {
  const calls = [];
  const statusText = { value: "" };
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        const tableName = payload.tableName;
        return {
          sessionId: `session-${tableName}`,
          tableName,
          columns: [{ column_name: "id" }, { column_name: "name" }],
          primaryKeys: ["id"],
          rows: [{ id: tableName === "player" ? "1" : "2", name: tableName === "player" ? "Ada" : "Core" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_files") return "C:/exports/game_db";
      throw new Error(`unexpected command ${command}`);
    },
    statusText,
  });

  transfer.openBatchExport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }],
  });
  transfer.setBatchExportMode("separate");

  const result = await transfer.executeBatchExport();

  const saveCall = calls.find((call) => call.command === "save_export_files");
  assert.ok(saveCall, "expected separate export to save multiple files through one command");
  assert.deepEqual(saveCall.payload.files.map((file) => file.fileName), ["player.xlsx", "guild.xlsx"]);

  const playerWorkbook = XLSX.read(Uint8Array.from(saveCall.payload.files[0].data), { type: "array" });
  const guildWorkbook = XLSX.read(Uint8Array.from(saveCall.payload.files[1].data), { type: "array" });
  assert.deepEqual(playerWorkbook.SheetNames, ["player"]);
  assert.deepEqual(guildWorkbook.SheetNames, ["guild"]);
  assert.equal(playerWorkbook.Sheets.player.B2.v, "Ada");
  assert.equal(guildWorkbook.Sheets.guild.B2.v, "Core");
  assert.equal(result.fileCount, 2);
  assert.match(statusText.value, /批量导出完成/);
});

test("batch export adds a field comments sheet to every separate workbook when selected", async () => {
  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        return {
          sessionId: `session-${payload.tableName}`,
          tableName: payload.tableName,
          columns: [{
            column_name: "id",
            column_type: "int",
            is_nullable: false,
            is_primary_key: true,
            column_comment: `${payload.tableName} ID`,
          }],
          rows: [{ id: "1" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_files") return "C:/exports/game_db";
      if (command === "close_table_session") return { closed: true };
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchExport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }],
  });
  transfer.setBatchExportMode("separate");
  transfer.setBatchExportIncludeColumnComments(true);

  await transfer.executeBatchExport();

  const files = calls.find((call) => call.command === "save_export_files").payload.files;
  const playerWorkbook = XLSX.read(Uint8Array.from(files[0].data), { type: "array" });
  const guildWorkbook = XLSX.read(Uint8Array.from(files[1].data), { type: "array" });
  assert.deepEqual(playerWorkbook.SheetNames, ["player", "player字段备注"]);
  assert.deepEqual(guildWorkbook.SheetNames, ["guild", "guild字段备注"]);
  assert.equal(playerWorkbook.Sheets["player字段备注"].G2.v, "player ID");
  assert.equal(guildWorkbook.Sheets["guild字段备注"].G2.v, "guild ID");
});

test("batch export field comments option resets when the dialog is reopened", () => {
  const transfer = useBatchTransfer({ invokeWorkbench: async () => null });
  const source = { connectionId: "demo", database: "game_db", tables: [{ table_name: "player" }] };

  transfer.openBatchExport(source);
  transfer.setBatchExportIncludeColumnComments(true);
  transfer.closeBatchExport();
  transfer.openBatchExport(source);

  assert.equal(transfer.batchExport.includeColumnComments, false);
});

test("batch export preserves the field comments suffix for long table names", async () => {
  const calls = [];
  const tableName = "this_is_a_very_long_table_name_for_players";
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "open_table_session") {
        return {
          sessionId: "session-long-name",
          tableName: payload.tableName,
          columns: [{ column_name: "id", column_comment: "玩家 ID" }],
          rows: [{ id: "1" }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_file") return "C:/exports/game_db-tables.xlsx";
      if (command === "close_table_session") return { closed: true };
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchExport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: tableName }],
  });
  transfer.setBatchExportIncludeColumnComments(true);
  await transfer.executeBatchExport();

  const workbook = XLSX.read(
    Uint8Array.from(calls.find((call) => call.command === "save_export_file").payload.data),
    { type: "array" },
  );
  const commentsSheetName = workbook.SheetNames[1];
  assert.ok(commentsSheetName.length <= 31);
  assert.match(commentsSheetName, /字段备注$/);
});

test("batch export yields progress phases while building many files", async () => {
  const observed = [];
  let transfer;
  transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      if (command === "open_table_session") {
        return {
          sessionId: `session-${payload.tableName}`,
          tableName: payload.tableName,
          columns: [{ column_name: "id" }, { column_name: "name" }],
          primaryKeys: ["id"],
          rows: [{ id: payload.tableName, name: `row-${payload.tableName}` }],
          totalRows: 1,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "save_export_files") return "C:/exports/game_db";
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
    scheduleYield: async () => {
      observed.push({
        phase: transfer.batchExport.progress.phase,
        current: transfer.batchExport.progress.current,
        done: transfer.batchExport.progress.done,
      });
    },
  });

  transfer.openBatchExport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }, { table_name: "mail" }],
  });
  transfer.setBatchExportMode("separate");

  await transfer.executeBatchExport();

  assert.ok(observed.length >= 3);
  assert.ok(observed.some((item) => item.phase === "读取表数据" && item.current === "player"));
  assert.ok(observed.some((item) => item.phase === "生成 Excel"));
  assert.ok(observed.some((item) => item.phase === "保存文件"));
});

test("batch import maps workbook sheets to tables and inserts rows", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["2", "Bob"],
    ]),
    "player",
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["id"], ["9"]]), "missing_table");

  const calls = [];
  const statusText = { value: "" };
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          table_comment: "",
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          tableComment: "",
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [{ id: "1", name: "Ada" }],
          totalRows: 1,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText,
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.deepEqual(
    transfer.batchImport.sheets.map((sheet) => ({
      sheetName: sheet.sheetName,
      targetTableName: sheet.targetTableName,
      selected: transfer.batchImport.selectedSheetNames.has(sheet.sheetName),
    })),
    [
      { sheetName: "player", targetTableName: "player", selected: true },
      { sheetName: "missing_table", targetTableName: "", selected: false },
    ],
  );

  const importCalls = calls.filter((call) => call.command === "import_rows");
  assert.equal(importCalls.length, 1);
  assert.deepEqual(importCalls[0].payload.request, {
    sessionId: "session-player",
    rows: [{ id: "2", name: "Bob" }],
  });
  assert.deepEqual(
    calls.filter((call) => call.command === "close_table_session").map((call) => call.payload),
    [{ sessionId: "session-player" }],
  );
  assert.match(statusText.value, /批量导入完成/);
});

test("batch import automatically excludes exported field comments sheets", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["id", "name"], ["2", "Bob"]]),
    "player",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["表名", "字段名", "字段类型", "可为空", "主键", "默认值", "字段备注"],
      ["player", "id", "int", "否", "是", "", "玩家 ID"],
    ]),
    "player字段备注",
  );

  const transfer = useBatchTransfer({ invokeWorkbench: async () => null, statusText: { value: "" } });
  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });

  await transfer.loadBatchImportFile(createWorkbookFile(workbook));

  assert.deepEqual(transfer.batchImport.sheets.map((sheet) => sheet.sheetName), ["player"]);
  assert.equal(transfer.batchImport.ignoredSheetCount, 1);
  assert.deepEqual([...transfer.batchImport.selectedSheetNames], ["player"]);
});

test("batch import keeps a real table whose name ends with field comments", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["表名", "字段名", "字段类型", "可为空", "主键", "默认值", "字段备注"],
      ["audit", "id", "int", "否", "是", "", "审计 ID"],
    ]),
    "audit字段备注",
  );

  const transfer = useBatchTransfer({ invokeWorkbench: async () => null, statusText: { value: "" } });
  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "audit字段备注" }],
  });

  await transfer.loadBatchImportFile(createWorkbookFile(workbook));

  assert.equal(transfer.batchImport.ignoredSheetCount, 0);
  assert.equal(transfer.batchImport.sheets[0].targetTableName, "audit字段备注");
});

test("separate batch import reports field comments sheets ignored inside each file", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["id", "name"], ["2", "Bob"]]),
    "player",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["表名", "字段名", "字段类型", "可为空", "主键", "默认值", "字段备注"],
      ["player", "name", "varchar(32)", "是", "否", "", "显示名称"],
    ]),
    "player字段备注",
  );

  const transfer = useBatchTransfer({ invokeWorkbench: async () => null, statusText: { value: "" } });
  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  transfer.setBatchImportMode("separate");

  await transfer.loadBatchImportFiles([createWorkbookFile(workbook, "player.xlsx")]);

  assert.equal(transfer.batchImport.ignoredSheetCount, 1);
  assert.equal(transfer.batchImport.sheets[0].workbookSheetName, "player");
  assert.equal(transfer.batchImport.sheets[0].targetTableName, "player");
});

test("batch import reads formatted date cells instead of Excel serial numbers", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["id", "created_at"],
    ["2", new Date(Date.UTC(2024, 0, 2))],
  ]);
  sheet.B2.z = "yyyy-mm-dd";
  XLSX.utils.book_append_sheet(workbook, sheet, "events");

  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "created_at", column_type: "date", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-events",
          tableName: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "created_at", column_type: "date", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "events" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.equal(transfer.batchImport.progress.errors.length, 0);
  assert.deepEqual(
    calls.filter((call) => call.command === "import_rows").flatMap((call) => call.payload.request.rows),
    [{ id: "2", created_at: "2024-01-02" }],
  );
});

test("batch import can map separate workbook files by file name", async () => {
  const playerWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    playerWorkbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["2", "Bob"],
    ]),
    "Sheet1",
  );
  const guildWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    guildWorkbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["8", "Core"],
    ]),
    "data",
  );

  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: `session-${payload.tableName}`,
          tableName: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }],
  });
  transfer.setBatchImportMode("separate");
  await transfer.loadBatchImportFiles([
    createWorkbookFile(playerWorkbook, "player.xlsx"),
    createWorkbookFile(guildWorkbook, "guild.xlsx"),
  ]);
  const result = await transfer.executeBatchImport();

  assert.deepEqual(
    transfer.batchImport.sheets.map((sheet) => ({
      sheetName: sheet.sheetName,
      sourceFileName: sheet.sourceFileName,
      targetTableName: sheet.targetTableName,
      selected: transfer.batchImport.selectedSheetNames.has(sheet.sheetName),
    })),
    [
      { sheetName: "player.xlsx", sourceFileName: "player.xlsx", targetTableName: "player", selected: true },
      { sheetName: "guild.xlsx", sourceFileName: "guild.xlsx", targetTableName: "guild", selected: true },
    ],
  );

  assert.deepEqual(
    calls.filter((call) => call.command === "import_rows").map((call) => call.payload.request),
    [
      { sessionId: "session-player", rows: [{ id: "2", name: "Bob" }] },
      { sessionId: "session-guild", rows: [{ id: "8", name: "Core" }] },
    ],
  );
  assert.deepEqual(result.tableNames.sort(), ["guild", "player"]);
});

test("batch import yields while reading separate workbook files", async () => {
  const playerWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(playerWorkbook, XLSX.utils.aoa_to_sheet([["id"], ["1"]]), "Sheet1");
  const guildWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(guildWorkbook, XLSX.utils.aoa_to_sheet([["id"], ["2"]]), "Sheet1");

  const observed = [];
  let transfer;
  transfer = useBatchTransfer({
    async invokeWorkbench(command) {
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
    scheduleYield: async () => {
      observed.push({
        status: transfer.batchImport.status,
        phase: transfer.batchImport.progress.phase,
        current: transfer.batchImport.progress.current,
        done: transfer.batchImport.progress.done,
      });
    },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }, { table_name: "guild" }],
  });
  transfer.setBatchImportMode("separate");
  await transfer.loadBatchImportFiles([
    createWorkbookFile(playerWorkbook, "player.xlsx"),
    createWorkbookFile(guildWorkbook, "guild.xlsx"),
  ]);

  assert.ok(observed.some((item) => item.status === "reading" && item.phase === "读取 Excel" && item.current === "player.xlsx"));
  assert.ok(observed.some((item) => item.status === "reading" && item.phase === "读取 Excel" && item.current === "guild.xlsx"));
  assert.deepEqual(transfer.batchImport.sheets.map((sheet) => sheet.targetTableName), ["player", "guild"]);
  assert.equal(transfer.batchImport.status, "idle");
});

test("batch import cannot execute while workbook files are still reading", async () => {
  let releaseRead;
  const delayedFile = {
    name: "player.xlsx",
    async arrayBuffer() {
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["id"], ["1"]]), "Sheet1");
      const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
  const transfer = useBatchTransfer({
    async invokeWorkbench(command) {
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
    scheduleYield: async () => {},
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  transfer.setBatchImportMode("separate");
  const loading = transfer.loadBatchImportFiles([delayedFile]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(transfer.batchImport.status, "reading");
  assert.equal(transfer.canExecuteBatchImport.value, false);

  releaseRead();
  await loading;
  assert.equal(transfer.batchImport.status, "idle");
  assert.equal(transfer.canExecuteBatchImport.value, true);
});

test("batch import yields while inserting a large sheet", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ...Array.from({ length: 130 }, (_, index) => [`${index + 1}`, `Name ${index + 1}`]),
    ]),
    "player",
  );

  const observed = [];
  let transfer;
  transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 10000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
    scheduleYield: async () => {
      observed.push({
        phase: transfer.batchImport.progress.phase,
        current: transfer.batchImport.progress.current,
        done: transfer.batchImport.progress.done,
        total: transfer.batchImport.progress.total,
      });
    },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.ok(observed.some((item) => item.phase === "写入数据库" && item.current === "player" && item.done > 0 && item.done < item.total));
  assert.equal(transfer.batchImport.progress.done, 130);
});

test("batch import sends 250 rows in three chunks and aggregates upsert outcomes", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ...Array.from({ length: 250 }, (_, index) => [`${index + 1}`, `Name ${index + 1}`]),
    ]),
    "player",
  );

  const calls = [];
  let importCall = 0;
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(32)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          columns: [],
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
        };
      }
      if (command === "import_rows") {
        importCall += 1;
        const count = payload.request.rows.length;
        if (importCall === 1) {
          return { inserted: count - 2, updated: 1, unchanged: 1, errors: [], outcomes: [] };
        }
        return { inserted: count, updated: 0, unchanged: 0, errors: [], outcomes: [] };
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  const result = await transfer.executeBatchImport();

  const importCalls = calls.filter((call) => call.command === "import_rows");
  assert.deepEqual(importCalls.map((call) => call.payload.request.rows.length), [100, 100, 50]);
  assert.ok(calls.every((call) => call.command !== "insert_row"));
  assert.deepEqual(
    { inserted: result.inserted, updated: result.updated, unchanged: result.unchanged },
    { inserted: 248, updated: 1, unchanged: 1 },
  );
  assert.equal(transfer.batchImport.progress.done, 250);
});

test("batch import stops a sheet before writing when its table has no primary key", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["name"],
      ...Array.from({ length: 250 }, (_, index) => [`Name ${index + 1}`]),
    ]),
    "notes",
  );

  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "name", column_type: "varchar(32)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "notes" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  const result = await transfer.executeBatchImport();

  assert.equal(calls.filter((call) => call.command === "import_rows").length, 0);
  assert.equal(calls.filter((call) => call.command === "open_table_session").length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /没有主键/);
  assert.equal(transfer.batchImport.progress.done, 250);
  assert.equal(transfer.batchImport.sheets[0].status, "failed");
});

test("batch import cancellation stops before the next chunk and keeps completed rows", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ...Array.from({ length: 250 }, (_, index) => [`${index + 1}`, `Name ${index + 1}`]),
    ]),
    "player",
  );

  const calls = [];
  let transfer;
  transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(32)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return { sessionId: "session-player", tableName: payload.tableName, rows: [] };
      }
      if (command === "import_rows") {
        transfer.cancelBatchImport();
        return successfulImportRows(payload);
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  const result = await transfer.executeBatchImport();

  const importCalls = calls.filter((call) => call.command === "import_rows");
  assert.equal(importCalls.length, 1);
  assert.equal(importCalls[0].payload.request.rows.length, 100);
  assert.equal(result.cancelled, true);
  assert.equal(result.inserted, 100);
  assert.equal(transfer.batchImport.progress.done, 100);
  assert.equal(transfer.batchImport.status, "cancelled");
});

test("batch import stays completed when cancellation arrives during the final chunk", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ...Array.from({ length: 50 }, (_, index) => [`${index + 1}`, `Name ${index + 1}`]),
    ]),
    "player",
  );

  let transfer;
  transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(32)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return { sessionId: "session-player", tableName: payload.tableName, rows: [] };
      }
      if (command === "import_rows") {
        transfer.cancelBatchImport();
        return successfulImportRows(payload);
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  const result = await transfer.executeBatchImport();

  assert.equal(result.cancelled, false);
  assert.equal(result.inserted, 50);
  assert.equal(transfer.batchImport.status, "succeeded");
});

test("batch import maps backend row errors back to Excel row metadata", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["1", "Good"],
      ["2", "Too long"],
    ]),
    "player",
  );

  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(4)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return { sessionId: "session-player", tableName: payload.tableName, rows: [] };
      }
      if (command === "import_rows") {
        return {
          inserted: 1,
          updated: 0,
          unchanged: 0,
          outcomes: [],
          errors: [{ index: 1, columnName: "name", error: "字段长度超限" }],
        };
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.deepEqual(transfer.batchImport.progress.errors, [{
    sheetName: "player",
    tableName: "player",
    row: 3,
    columnName: "name",
    value: "Too long",
    error: "字段长度超限",
  }]);
});

test("batch import keeps aggregate counters numeric when no columns can be mapped", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["unknown_column"],
      ["value"],
    ]),
    "player",
  );

  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return { sessionId: "session-player", tableName: payload.tableName, rows: [] };
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  const result = await transfer.executeBatchImport();

  assert.deepEqual(
    { inserted: result.inserted, updated: result.updated, unchanged: result.unchanged },
    { inserted: 0, updated: 0, unchanged: 0 },
  );
  assert.equal(result.errors.length, 1);
});

test("batch import counts skipped blank rows as completed progress", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["2", "Bob"],
      ["", ""],
    ]),
    "player",
  );

  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.equal(transfer.batchImport.progress.total, 2);
  assert.equal(transfer.batchImport.progress.done, 2);
  assert.equal(transfer.batchImport.progress.skipped, 1);
});

test("batch import preserves blank cells on non-empty rows while skipping blank rows", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["", ""],
      ["2", ""],
    ]),
    "player",
  );

  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.equal(transfer.batchImport.progress.skipped, 1);
  assert.deepEqual(
    calls.filter((call) => call.command === "import_rows").map((call) => call.payload.request),
    [{ sessionId: "session-player", rows: [{ id: "2", name: "" }] }],
  );
});

test("batch import omits blank non-text cells so database defaults can apply", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "sort_order", "name"],
      ["2", "", "Bob"],
    ]),
    "player",
  );

  const calls = [];
  const columns = [
    { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
    { column_name: "sort_order", column_type: "int", is_nullable: false, default_mode: "value" },
    { column_name: "name", column_type: "varchar(16)", is_nullable: false },
  ];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") return { table_name: payload.tableName, columns };
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          columns,
          primaryKeys: ["id"],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") return successfulImportRows(payload);
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.equal(transfer.batchImport.progress.errors.length, 0);
  assert.deepEqual(
    calls.filter((call) => call.command === "import_rows").flatMap((call) => call.payload.request.rows),
    [{ id: "2", name: "Bob" }],
  );
});

test("batch import updates primary keys already visible on the current page", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["1", "Grace"],
    ]),
    "player",
  );

  const calls = [];
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "get_table_schema") {
        return {
          table_name: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
        };
      }
      if (command === "open_table_session") {
        return {
          sessionId: "session-player",
          tableName: payload.tableName,
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
            { column_name: "name", column_type: "varchar(16)", is_primary_key: false, is_nullable: false },
          ],
          primaryKeys: ["id"],
          rows: [{ id: "1", name: "Ada" }],
          totalRows: 1,
          page: 1,
          pageSize: 1000,
        };
      }
      if (command === "import_rows") {
        return successfulImportRows(payload, { inserted: 0, updated: 1 });
      }
      throw new Error(`unexpected command ${command}`);
    },
    statusText: { value: "" },
  });

  transfer.openBatchImport({
    connectionId: "demo",
    database: "game_db",
    tables: [{ table_name: "player" }],
  });
  await transfer.loadBatchImportFile(createWorkbookFile(workbook));
  await transfer.executeBatchImport();

  assert.equal(transfer.batchImport.progress.total, 1);
  assert.equal(transfer.batchImport.progress.done, 1);
  assert.equal(transfer.batchImport.progress.errors.length, 0);
  assert.equal(transfer.batchImport.progress.updated, 1);
  assert.deepEqual(
    calls.filter((call) => call.command === "import_rows").map((call) => call.payload.request),
    [{ sessionId: "session-player", rows: [{ id: "1", name: "Grace" }] }],
  );
});

test("batch import exports structured errors as an xlsx workbook", async () => {
  const calls = [];
  const statusText = { value: "" };
  const transfer = useBatchTransfer({
    async invokeWorkbench(command, payload) {
      calls.push({ command, payload });
      if (command === "save_export_file") return "C:/exports/game_db-import-errors.xlsx";
      throw new Error(`unexpected command ${command}`);
    },
    statusText,
  });
  transfer.openBatchImport({ connectionId: "demo", database: "game_db", tables: [] });
  transfer.batchImport.sheets.push({
    sheetName: "player.xlsx",
    sourceFileName: "player.xlsx",
    workbookSheetName: "Sheet1",
    targetTableName: "player",
  });
  transfer.batchImport.progress.errors.push({
    sheetName: "player.xlsx",
    tableName: "player",
    row: 12,
    columnName: "level",
    value: "abc",
    error: "字段 level 需要整数",
  });

  await transfer.exportBatchImportErrors();

  const saveCall = calls.find((call) => call.command === "save_export_file");
  assert.match(saveCall.payload.fileName, /^game_db-import-errors-\d{8}-\d{6}\.xlsx$/);
  const workbook = XLSX.read(Uint8Array.from(saveCall.payload.data), { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["批量导入错误日志"]);
  assert.deepEqual(
    XLSX.utils.sheet_to_json(workbook.Sheets["批量导入错误日志"], { header: 1, defval: "" }),
    [
      ["来源文件", "工作表", "目标表", "Excel 行号", "字段", "原值", "错误原因"],
      ["player.xlsx", "Sheet1", "player", 12, "level", "abc", "字段 level 需要整数"],
    ],
  );
  assert.match(statusText.value, /错误日志已导出/);
});

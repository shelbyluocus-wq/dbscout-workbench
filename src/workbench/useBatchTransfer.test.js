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
      if (command === "insert_row") return { affected: 1 };
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

  const insertCalls = calls.filter((call) => call.command === "insert_row");
  assert.equal(insertCalls.length, 1);
  assert.deepEqual(insertCalls[0].payload.request, {
    sessionId: "session-player",
    draft: { id: "2", name: "Bob" },
  });
  assert.deepEqual(
    calls.filter((call) => call.command === "close_table_session").map((call) => call.payload),
    [{ sessionId: "session-player" }],
  );
  assert.match(statusText.value, /批量导入完成/);
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
      if (command === "insert_row") return { affected: 1 };
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
    calls.filter((call) => call.command === "insert_row").map((call) => call.payload.request.draft),
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
      if (command === "insert_row") return { affected: 1 };
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
    calls.filter((call) => call.command === "insert_row").map((call) => call.payload.request),
    [
      { sessionId: "session-player", draft: { id: "2", name: "Bob" } },
      { sessionId: "session-guild", draft: { id: "8", name: "Core" } },
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
      ...Array.from({ length: 30 }, (_, index) => [`${index + 1}`, `Name ${index + 1}`]),
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
      if (command === "insert_row") return { affected: 1 };
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
  assert.equal(transfer.batchImport.progress.done, 30);
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
      if (command === "insert_row") return { affected: 1 };
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
      if (command === "insert_row") return { affected: 1 };
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
    calls.filter((call) => call.command === "insert_row").map((call) => call.payload.request),
    [{ sessionId: "session-player", draft: { id: "2", name: "" } }],
  );
});

test("batch import lets insert_row report primary keys already visible on the current page", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["id", "name"],
      ["1", "Ada"],
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
      if (command === "insert_row") throw new Error("主键重复，不能保存");
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
  assert.equal(transfer.batchImport.progress.errors.length, 1);
  assert.match(transfer.batchImport.progress.errors[0].error, /主键重复/);
  assert.deepEqual(
    calls.filter((call) => call.command === "insert_row").map((call) => call.payload.request),
    [{ sessionId: "session-player", draft: { id: "1", name: "Ada" } }],
  );
});

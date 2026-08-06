import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";
import * as XLSX from "xlsx";
import { useImportWizard } from "./composables/useImportWizard.js";
import { mockWorkbenchInvoke, resetMockWorkbenchState } from "./mock/mockBackend.js";
import { getOrInitRows } from "./mock/mockRows.js";

function createWizard() {
  const tab = reactive({
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    page: 1,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "name", column_type: "varchar(4)", is_nullable: false },
    ],
    rows: [{ id: "1", level: "10", name: "Ada" }],
  });
  const invokeCalls = [];
  const fetchCalls = [];
  const statusText = { value: "" };
  const wizard = useImportWizard(
    async (command, payload) => {
      invokeCalls.push({ command, payload });
      if (command === "replace_table_rows") {
        return {
          inserted: payload.request.rows.length,
          updated: 0,
          unchanged: 0,
          deleted: 0,
        };
      }
      return { affected: 1 };
    },
    computed(() => tab),
    {
      async fetchPage(target, page) {
        fetchCalls.push({ target, page });
      },
    },
    { statusText },
  );
  return { wizard, tab, invokeCalls, fetchCalls, statusText };
}

test("import preflight blocks scalar errors before replace_table_rows calls", async () => {
  const { wizard, invokeCalls, fetchCalls, statusText } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "abc", "Bob"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(invokeCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
  assert.equal(wizard.importWizard.importing, false);
  assert.equal(wizard.importWizard.progress.total, 1);
  assert.equal(wizard.importWizard.progress.done, 0);
  assert.deepEqual(
    wizard.importWizard.progress.errors.map((error) => ({
      row: error.row,
      columnName: error.columnName,
      code: error.code,
    })),
    [
      { row: 2, columnName: "level", code: "invalid-integer" },
    ],
  );
  assert.match(statusText.value, /导入校验失败|瀵煎叆/);
});

test("single-table import sends existing primary keys to the atomic replacement command", async () => {
  const { wizard, invokeCalls, fetchCalls } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["1", "11", "Ted"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(invokeCalls.flatMap((call) => call.payload.request.rows), [
    { id: "1", level: "11", name: "Ted" },
  ]);
});

test("single-table import makes the target rows match the spreadsheet by default", async () => {
  resetMockWorkbenchState();
  const connectionId = "single-import-replacement";
  const database = "game_db";
  const tableName = "player";
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId,
    database,
    tableName,
    options: { page: 1, pageSize: 10 },
  });
  const existing = page.rows[0];
  const headers = page.columns.map((column) => column.column_name);
  const updated = { ...existing, username: "spreadsheet-wins" };
  const inserted = { ...existing, id: "990001", username: "spreadsheet-new" };
  const originalRowCount = getOrInitRows(connectionId, database, tableName).length;
  const tab = reactive({ ...page, id: "replacement-tab", tableName, page: 1 });
  const statusText = { value: "" };
  const wizard = useImportWizard(
    mockWorkbenchInvoke,
    computed(() => tab),
    { fetchPage: async () => {} },
    { statusText },
  );
  wizard.importWizard.rawRows = [
    headers,
    headers.map((header) => updated[header]),
    headers.map((header) => inserted[header]),
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  const finalRows = getOrInitRows(connectionId, database, tableName);
  assert.deepEqual(finalRows.map((row) => row.id), [existing.id, inserted.id]);
  assert.equal(finalRows[0].username, updated.username);
  assert.equal(finalRows[1].username, inserted.username);
  assert.equal(wizard.importWizard.progress.inserted, 1);
  assert.equal(wizard.importWizard.progress.updated, 1);
  assert.equal(wizard.importWizard.progress.deleted, originalRowCount - 1);
  assert.equal(wizard.importWizard.progress.unchanged, 0);
  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(
    statusText.value,
    `导入完成：新增 1，覆盖 1，删除 ${originalRowCount - 1}，未变化 0`,
  );
});

test("single-table replacement reports the exact spreadsheet row and keeps the target unchanged on failure", async () => {
  resetMockWorkbenchState();
  const connectionId = "single-import-replacement-error";
  const database = "game_db";
  const tableName = "player";
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId,
    database,
    tableName,
    options: { page: 1, pageSize: 10 },
  });
  const before = getOrInitRows(connectionId, database, tableName).map((row) => ({ ...row }));
  const headers = page.columns.map((column) => column.column_name);
  const tab = reactive({ ...page, id: "replacement-error-tab", tableName, page: 1 });
  const statusText = { value: "" };
  const wizard = useImportWizard(
    mockWorkbenchInvoke,
    computed(() => tab),
    { fetchPage: async () => {} },
    { statusText },
  );
  wizard.importWizard.rawRows = [
    headers,
    headers.map((header) => page.rows[0][header]),
    headers.map((header) => (header === "username" ? "duplicate" : page.rows[0][header])),
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 1);
  assert.equal(wizard.importWizard.progress.errors[0].row, 3);
  assert.match(wizard.importWizard.progress.errors[0].error, /主键重复/);
  assert.deepEqual(getOrInitRows(connectionId, database, tableName), before);
});

test("import preflight treats composite primary keys as a full tuple even when tab primaryKeys is stale", async () => {
  const { wizard, tab, invokeCalls, fetchCalls } = createWizard();
  tab.tableName = "giftoptionalprop";
  tab.primaryKeys = ["GiftOptionalID"];
  tab.columns = [
    { column_name: "GiftOptionalID", column_type: "int", is_primary_key: true, is_nullable: false },
    { column_name: "Idx", column_type: "int", is_primary_key: true, is_nullable: false },
    { column_name: "Note", column_type: "varchar(64)", is_primary_key: false, is_nullable: false },
  ];
  wizard.importWizard.rawRows = [
    ["GiftOptionalID", "Idx", "Note"],
    ["1", "1", "gift-1"],
    ["1", "2", "gift-2"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(invokeCalls.flatMap((call) => call.payload.request.rows), [
    { GiftOptionalID: "1", Idx: "1", Note: "gift-1" },
    { GiftOptionalID: "1", Idx: "2", Note: "gift-2" },
  ]);
});

test("import preserves explicit blank spreadsheet cells for non-null string columns", async () => {
  const { wizard, invokeCalls, fetchCalls, statusText } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "12", ""],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(wizard.importWizard.progress.done, 1);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(invokeCalls.flatMap((call) => call.payload.request.rows), [
    { id: "2", level: "12", name: "" },
  ]);
  assert.match(statusText.value, /导入完成|瀵煎叆/);
});

test("import omits blank non-text cells so database defaults can apply", async () => {
  const { wizard, tab, invokeCalls } = createWizard();
  tab.columns = [
    { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
    { column_name: "sort_order", column_type: "int", is_nullable: false, default_mode: "value" },
    { column_name: "name", column_type: "varchar(16)", is_nullable: false },
  ];
  wizard.importWizard.rawRows = [
    ["id", "sort_order", "name"],
    ["2", "", "Bob"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.deepEqual(invokeCalls.flatMap((call) => call.payload.request.rows), [
    { id: "2", name: "Bob" },
  ]);
  assert.deepEqual(invokeCalls[0].payload.request.mappedColumns, ["id", "sort_order", "name"]);
});

test("import skips completely blank spreadsheet rows while preserving blank cells on non-empty rows", async () => {
  const { wizard, invokeCalls } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["", "", ""],
    ["2", "12", ""],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(wizard.importWizard.progress.done, 2);
  assert.deepEqual(invokeCalls.flatMap((call) => call.payload.request.rows), [
    { id: "2", level: "12", name: "" },
  ]);
});

test("import reports inserted rows without counting skipped blank rows as successful", async () => {
  const { wizard, invokeCalls, statusText } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["", "", ""],
    ["2", "12", "Bob"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.done, 2);
  assert.equal(wizard.importWizard.progress.inserted, 1);
  assert.equal(wizard.importWizard.progress.skipped, 1);
  assert.deepEqual(invokeCalls.flatMap((call) => call.payload.request.rows), [
    { id: "2", level: "12", name: "Bob" },
  ]);
  assert.equal(statusText.value, "导入完成：新增 1，覆盖 0，删除 0，未变化 0，跳过 1");
});

test("import clears stale column mapping when a selected sheet has no data rows", () => {
  const { wizard } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "12", "Bob"],
  ];
  wizard.goToImportStep(3);
  assert.equal(wizard.importWizard.mapping.length, 3);

  wizard.importWizard.rawRows = [["only_header"]];
  wizard.goToImportStep(3);

  assert.deepEqual(wizard.importWizard.mapping, []);
  assert.match(wizard.importWizard.warnings.join("\n"), /没有可导入的数据/);
});

test("import mapping always uses the first spreadsheet row as column headers", () => {
  const { wizard } = createWizard();

  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "12", "Bob"],
  ];
  wizard.goToImportStep(3);

  assert.deepEqual(
    wizard.importWizard.mapping.map((item) => ({
      fileCol: item.fileCol,
      fileColIndex: item.fileColIndex,
      tableCol: item.tableCol,
      skip: item.skip,
    })),
    [
      { fileCol: "id", fileColIndex: 0, tableCol: "id", skip: false },
      { fileCol: "level", fileColIndex: 1, tableCol: "level", skip: false },
      { fileCol: "name", fileColIndex: 2, tableCol: "name", skip: false },
    ],
  );
});

test("selectImportFile reads an xlsx file without requiring a file input change event", async () => {
  const { wizard } = createWizard();
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["id", "level", "name"],
    ["2", "12", "Bob"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "players");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const file = new File([buffer], "players.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  await wizard.selectImportFile(file);

  assert.equal(wizard.importWizard.fileName, "players.xlsx");
  assert.deepEqual(wizard.importWizard.sheetNames, ["players"]);
  assert.equal(wizard.importWizard.step, 2);
  assert.deepEqual(wizard.importWizard.rawRows, [
    ["id", "level", "name"],
    ["2", "12", "Bob"],
  ]);
});

test("selectImportFile reads formatted date cells instead of Excel serial numbers", async () => {
  const { wizard } = createWizard();
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["id", "level", "name", "created_at"],
    ["2", "12", "Bob", new Date(Date.UTC(2024, 0, 2))],
  ]);
  sheet.D2.z = "yyyy-mm-dd";
  XLSX.utils.book_append_sheet(workbook, sheet, "players");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const file = new File([buffer], "players.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  await wizard.selectImportFile(file);

  assert.equal(wizard.importWizard.rawRows[1][3], "2024-01-02");
});

test("single-table import reopens an expired session and retries the replacement once", async () => {
  const tab = reactive({
    id: "tab-expired-session",
    tableName: "player",
    sessionId: "session-old",
    page: 1,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "name", column_type: "varchar(4)", is_nullable: false },
    ],
    rows: [],
  });
  const invokeCalls = [];
  const reopenCalls = [];
  const statusText = { value: "" };
  const wizard = useImportWizard(
    async (command, payload) => {
      invokeCalls.push({ command, payload });
      if (command === "replace_table_rows") {
        if (payload.request.sessionId === "session-old") {
          throw new Error("表会话已失效，请重新打开表");
        }
        return {
          inserted: payload.request.rows.length,
          updated: 0,
          unchanged: 0,
          deleted: 0,
        };
      }
      return { affected: 1 };
    },
    computed(() => tab),
    {
      fetchPage: async () => {},
      reopenTableSession: async (target) => {
        reopenCalls.push(target);
        target.sessionId = "session-new";
        return target;
      },
    },
    { statusText },
  );
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "12", "Bob"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  const replaceCalls = invokeCalls.filter((call) => call.command === "replace_table_rows");
  assert.equal(replaceCalls.length, 2);
  assert.equal(replaceCalls[0].payload.request.sessionId, "session-old");
  assert.equal(replaceCalls[1].payload.request.sessionId, "session-new");
  assert.equal(reopenCalls.length, 1);
  assert.equal(reopenCalls[0], tab);
  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(wizard.importWizard.progress.inserted, 1);
  assert.match(statusText.value, /导入完成/);
});

test("single-table import surfaces the session error when no reopen hook is injected", async () => {
  const tab = reactive({
    id: "tab-expired-session-no-reopen",
    tableName: "player",
    sessionId: "session-old",
    page: 1,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "name", column_type: "varchar(4)", is_nullable: false },
    ],
    rows: [],
  });
  const invokeCalls = [];
  const statusText = { value: "" };
  const wizard = useImportWizard(
    async (command, payload) => {
      invokeCalls.push({ command, payload });
      if (command === "replace_table_rows") {
        throw new Error("表会话已失效，请重新打开表");
      }
      return { affected: 1 };
    },
    computed(() => tab),
    { fetchPage: async () => {} },
    { statusText },
  );
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "12", "Bob"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(invokeCalls.filter((call) => call.command === "replace_table_rows").length, 1);
  assert.equal(wizard.importWizard.progress.errors.length, 1);
  assert.match(statusText.value, /导入失败/);
  assert.match(statusText.value, /表会话已失效/);
});


test("import compare previews changes via previewOnly without writing", async () => {
  const { wizard, invokeCalls, statusText } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["1", "11", "Ada2"],
    ["2", "3", "Bob"],
  ];
  wizard.goToImportStep(3);

  const comparison = await wizard.compareImportChanges();

  assert.equal(comparison.status, "succeeded");
  assert.equal(wizard.importWizard.step4View, "comparison");
  const previewCalls = invokeCalls.filter((call) => call.command === "replace_table_rows");
  assert.equal(previewCalls.length, 1);
  assert.equal(previewCalls[0].payload.request.previewOnly, true);
  assert.deepEqual(previewCalls[0].payload.request.rows, [
    { id: "1", level: "11", name: "Ada2" },
    { id: "2", level: "3", name: "Bob" },
  ]);
  assert.deepEqual(comparison.tables[0].columns, [
    { name: "id", primaryKey: true },
    { name: "level", primaryKey: false },
    { name: "name", primaryKey: false },
  ]);
  assert.equal(comparison.summary.inserted, 2);
  assert.equal(comparison.summary.errors, 0);
  assert.match(statusText.value, /变化对比完成/);
});

test("import compare keeps before/after snapshots for the diff grid", async () => {
  const tab = reactive({
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    page: 1,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "name", column_type: "varchar(4)", is_nullable: false },
    ],
    rows: [{ id: "1", level: "10", name: "Ada" }],
  });
  const wizard = useImportWizard(
    async (command) => {
      if (command === "replace_table_rows") {
        return {
          inserted: 0,
          updated: 1,
          unchanged: 0,
          deleted: 0,
          outcomes: [
            {
              index: 0,
              status: "updated",
              preview: {
                identity: { id: "1" },
                changes: [{ columnName: "name", oldValue: "Ada", newValue: "Ada2" }],
                before: { id: "1", level: "10", name: "Ada" },
                after: { id: "1", level: "10", name: "Ada2" },
              },
            },
          ],
        };
      }
      return { affected: 1 };
    },
    computed(() => tab),
    { async fetchPage() {} },
    { statusText: { value: "" } },
  );
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["1", "10", "Ada2"],
  ];
  wizard.goToImportStep(3);

  const comparison = await wizard.compareImportChanges();

  assert.equal(comparison.rows.length, 1);
  assert.deepEqual(comparison.rows[0].before, { id: "1", level: "10", name: "Ada" });
  assert.deepEqual(comparison.rows[0].after, { id: "1", level: "10", name: "Ada2" });
});

test("import compare surfaces preflight errors as error rows without blocking the preview", async () => {
  const { wizard, invokeCalls } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "abc", "Bob"],
  ];
  wizard.goToImportStep(3);

  const comparison = await wizard.compareImportChanges();

  assert.equal(comparison.status, "partial");
  assert.equal(comparison.summary.errors, 1);
  const errorRows = comparison.rows.filter((row) => row.status === "error");
  assert.equal(errorRows.length, 1);
  assert.equal(errorRows[0].row, 2);
  // 预检错误不阻断只读预览
  assert.equal(invokeCalls.filter((call) => call.command === "replace_table_rows").length, 1);
  assert.equal(invokeCalls[0].payload.request.previewOnly, true);
});

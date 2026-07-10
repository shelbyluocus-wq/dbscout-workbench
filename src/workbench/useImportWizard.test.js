import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";
import * as XLSX from "xlsx";
import { useImportWizard } from "./composables/useImportWizard.js";

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

test("import preflight blocks scalar errors before insert_row calls", async () => {
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

test("import preflight does not block rows only because their primary key is visible on the current page", async () => {
  const { wizard, invokeCalls, fetchCalls } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["1", "11", "Ted"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(wizard.importWizard.progress.errors.length, 0);
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(invokeCalls.map((call) => call.payload.request.draft), [
    { id: "1", level: "11", name: "Ted" },
  ]);
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
  assert.deepEqual(invokeCalls.map((call) => call.payload.request.draft), [
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
  assert.deepEqual(invokeCalls.map((call) => call.payload.request.draft), [
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
  assert.deepEqual(invokeCalls.map((call) => call.payload.request.draft), [
    { id: "2", name: "Bob" },
  ]);
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
  assert.deepEqual(invokeCalls.map((call) => call.payload.request.draft), [
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
  assert.deepEqual(invokeCalls.map((call) => call.payload.request.draft), [
    { id: "2", level: "12", name: "Bob" },
  ]);
  assert.equal(statusText.value, "导入完成：1 成功，0 失败，1 跳过");
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

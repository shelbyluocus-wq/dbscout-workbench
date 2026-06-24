import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";
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

test("import preflight blocks invalid rows before insert_row calls", async () => {
  const { wizard, invokeCalls, fetchCalls, statusText } = createWizard();
  wizard.importWizard.rawRows = [
    ["id", "level", "name"],
    ["2", "abc", "Bob"],
    ["1", "11", "Ted"],
  ];
  wizard.goToImportStep(3);

  await wizard.executeImport();

  assert.equal(invokeCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
  assert.equal(wizard.importWizard.importing, false);
  assert.equal(wizard.importWizard.progress.total, 2);
  assert.equal(wizard.importWizard.progress.done, 0);
  assert.deepEqual(
    wizard.importWizard.progress.errors.map((error) => ({
      row: error.row,
      columnName: error.columnName,
      code: error.code,
    })),
    [
      { row: 2, columnName: "level", code: "invalid-integer" },
      { row: 3, columnName: "id", code: "duplicate-primary-key" },
    ],
  );
  assert.match(statusText.value, /导入校验失败|瀵煎叆/);
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

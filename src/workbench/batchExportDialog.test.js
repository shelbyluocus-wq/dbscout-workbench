import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dialog = readLocalizedContractSource(join(__dirname, "components", "BatchExportDialog.vue"), "utf8");
const transfer = readLocalizedContractSource(join(__dirname, "composables", "useBatchTransfer.js"), "utf8");
const { default: zhCN } = await import("./i18n/zhCN.js");

test("batch export can replace its selection with the current search results", () => {
  assert.match(dialog, /t\("batch\.selectSearchResults", \{ count: filteredTables\.value\.length \}\)/);
  assert.match(zhCN["batch.selectSearchResults"], /仅选搜索结果/);
  assert.match(dialog, /:indeterminate="allSelectionIndeterminate"/);
  assert.match(dialog, /setExportTableSelection\(value \? selectionScope\.value : \[\]\)/);
  assert.match(dialog, /matches: filteredTables\.value\.length/);
  assert.match(zhCN["batch.summarySearch"], /匹配 \{matches\}/);
  assert.match(dialog, /"batch\.exportTables", \{ count: selectedCount \}/);
  assert.equal(zhCN["batch.exportTables"], "导出 {count} 张表");
  assert.match(transfer, /function setExportTableSelection\(tableNames = \[\]\)/);
});

test("batch export exposes a real cancel action while exporting", () => {
  assert.match(dialog, /v-if="batch\.exporting"/);
  assert.match(dialog, /@click="transfer\.cancelBatchExport\(\)"/);
  assert.match(dialog, /正在取消…/);
  assert.match(dialog, /取消导出/);
  assert.match(transfer, /function cancelBatchExport\(\)/);
});

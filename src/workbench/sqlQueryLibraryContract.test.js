import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

function read(relativePath) {
  return readLocalizedContractSource(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

test("database homepage exposes the SQL query library beside table search", () => {
  const home = read("./components/DatabaseHome.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(home, /class="wb-dbhome-search"[\s\S]*class="wb-dbhome-actions"/);
  assert.match(home, /wb-dbhome-sql-entry/);
  assert.match(home, /aria-label="SQL"[\s\S]*wb-toolbar-action-label">SQL<\/span>/);
  assert.match(home, /wb-dbhome-action-group[\s\S]*wb-dbhome-sql-entry[\s\S]*aria-label="批量导出"/);
  assert.match(home, /emit\('open-sql-library'\)/);
  assert.match(pane, /<SqlQueryLibrary/);
  assert.match(orchestrator, /function openSqlLibrary/);
  assert.match(orchestrator, /@open-sql-library="openSqlLibrary"/);
});

test("SQL library provides document and file management actions", () => {
  const library = read("./components/SqlQueryLibrary.vue");
  const orchestrator = read("./MySqlWorkbench.vue");
  const css = read("./workbench.css");

  assert.match(library, /搜索查询名称或 SQL/);
  assert.match(library, /新建查询/);
  assert.match(library, /查询历史/);
  assert.match(library, /emit\('open-query'/);
  assert.match(library, /emit\('duplicate-query'/);
  assert.match(library, /emit\(["']rename-query["']/);
  assert.match(library, /emit\('delete-query'/);
  assert.match(orchestrator, /sqlDocumentStore\.upsertFromTab/);
  assert.match(orchestrator, /skipUnsaved \|\| tab\.documentId/);
  assert.doesNotMatch(css, /wb-sql-library-row-actions button[^\{]*\{[^\}]*display:\s*none/s);
});

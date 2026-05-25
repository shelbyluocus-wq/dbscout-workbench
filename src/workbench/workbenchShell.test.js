import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

function readAllComponents() {
  const dir = new URL("./components", import.meta.url).pathname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".vue"));
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

test("main.js mounts the MySQL workbench as the first screen", () => {
  const main = read("../main.js");

  assert.match(main, /import\s+MySqlWorkbench\s+from\s+["']\.\/workbench\/MySqlWorkbench\.vue["']/);
  assert.match(main, /import\s+["']\.\/workbench\/workbench\.css["']/);
  assert.match(main, /createApp\(MySqlWorkbench\)\.mount\("#app"\)/);
});

test("composables and mock modules use the Rust workbench commands", () => {
  const all = [
    read("./composables/useConnection.js"),
    read("./composables/useTableSession.js"),
    read("./composables/useGridEditor.js"),
    read("./composables/useImportWizard.js"),
    read("./composables/useRowSelection.js"),
    read("./mock/mockBackend.js"),
  ].join("\n");

  for (const command of [
    "list_connections",
    "list_databases",
    "list_tables",
    "get_table_schema",
    "open_table_session",
    "fetch_table_page",
    "update_cell",
    "insert_row",
    "delete_rows",
    "search_data",
  ]) {
    assert.match(all, new RegExp(`["']${command}["']`), `missing command: ${command}`);
  }
  assert.match(all, /mockWorkbenchInvoke/);
  assert.match(all, /game_db/);
});

test("workbench components render polished desktop database chrome", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const allComponents = readAllComponents();
  const styles = read("./workbench.css");
  const all = [orchestrator, allComponents].join("\n");

  for (const className of [
    "wb-navigation-pane",
    "wb-object-tabs",
    "wb-table-toolbar",
    "wb-info-pane",
  ]) {
    assert.match(all, new RegExp(`class=["'][^"']*${className}`), `missing class: ${className}`);
  }

  assert.match(all, /信息/);
  assert.match(styles, /--wb-accent/);
  assert.match(styles, /--wb-glass/);
  assert.match(styles, /backdrop-filter/);
  assert.match(styles, /@supports/);
  assert.match(styles, /\.wb-grid\s*\{[\s\S]*font-size:\s*12px/);
  assert.match(styles, /\.wb-table-toolbar/);
  assert.match(styles, /\.wb-row-index/);
});

test("workbench follows Navicat-like table interactions with composables", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const allComponents = readAllComponents();
  const styles = read("./workbench.css");
  const all = [orchestrator, allComponents].join("\n");

  assert.doesNotMatch(all, /wb-tool-button/);
  assert.match(all, /@contextmenu\.prevent/);
  assert.match(all, /class="wb-context-menu"/);
  assert.match(all, /refreshFromContextMenu/);
  assert.match(all, /commitInsertRow/);
  assert.match(all, /class="wb-insert-row"/);
  assert.match(styles, /\.wb-context-menu/);
  assert.match(styles, /\.wb-insert-row/);
});

test("tauri main window is configured as a normal database workbench window", () => {
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const main = config.app.windows.find((window) => window.label === "main");

  assert.ok(main.width >= 1200);
  assert.ok(main.height >= 760);
  assert.equal(main.decorations, true);
  assert.equal(main.resizable, true);
  assert.equal(main.alwaysOnTop, false);
  assert.equal(main.skipTaskbar, false);
  assert.equal(main.transparent, false);
  assert.equal(main.center, true);
});

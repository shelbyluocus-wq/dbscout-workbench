import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

function readAllComponents() {
  const dir = fileURLToPath(new URL("./components", import.meta.url));
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

test("data grid exposes its real scroll wrapper to editor and virtual grid", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(dataGrid, /grid-ready/);
  assert.match(dataGrid, /emit\(["']grid-ready["'],\s*gridWrapRef\.value\)/);
  assert.match(orchestrator, /function\s+setGridWrapElement/);
  assert.match(orchestrator, /@grid-ready="setGridWrapElement"/);
});

test("grid uses a single draggable native scrollbar", () => {
  const allComponents = readAllComponents();
  const styles = read("./workbench.css");

  assert.doesNotMatch(allComponents, /wb-grid-scroll-indicator/);
  assert.match(styles, /\.wb-grid-wrap\s*\{[\s\S]*scrollbar-width:\s*thin/);
  assert.doesNotMatch(styles, /\.wb-grid-wrap\s*\{[\s\S]*scrollbar-width:\s*none/);
  assert.doesNotMatch(styles, /\.wb-grid-wrap::-webkit-scrollbar\s*\{[\s\S]*display:\s*none/);
});

test("grid edit mode keeps text metrics stable with a thin single focus ring", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-grid td input\s*\{[^}]*height:\s*100%/);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*font:\s*inherit/);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*line-height:\s*25px/);
  assert.match(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*none/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*outline:\s*1px solid var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid-wrap:not\(:focus\) \.wb-grid td\.editing\s*\{[^}]*outline:\s*1px solid var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td\.selected input\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*2px solid var\(--wb-accent\)/);
});

test("data grid wires Excel-like drag range selection", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");
  const styles = read("./workbench.css");

  assert.match(dataGrid, /cell-mousedown/);
  assert.match(dataGrid, /@mousedown\.left/);
  assert.match(dataGrid, /cell-enter/);
  assert.match(dataGrid, /@mouseenter/);
  assert.match(dataGrid, /range-end/);
  assert.match(orchestrator, /@cell-mousedown="startRangeSelection"/);
  assert.match(orchestrator, /@cell-enter="extendRangeSelection"/);
  assert.match(orchestrator, /@range-end="finishRangeSelection"/);
  assert.match(styles, /\.wb-grid td\.selected:not\(\.range-selected\)/);
  assert.match(styles, /\.wb-grid td\.range-selected/);
  assert.match(styles, /--range-top-shadow/);
  assert.match(styles, /\.wb-grid td\.range-top/);
  assert.match(styles, /\.wb-grid td\.range-bottom/);
  assert.match(styles, /\.wb-grid td\.range-left/);
  assert.match(styles, /\.wb-grid td\.range-right/);
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

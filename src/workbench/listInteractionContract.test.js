import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("destructive confirmations focus Cancel; other confirmations focus the primary action", () => {
  const dialog = read("./components/ConfirmDialog.vue");

  assert.match(dialog, /const focusCancel = computed\(\(\) => props\.danger && Boolean\(props\.cancelText\)\)/);
  assert.match(dialog, /<button v-if="cancelText" type="button" :autofocus="focusCancel" @click="emit\('cancel'\)">/);
  assert.match(dialog, /class="wb-dialog-primary"[\s\S]*?:autofocus="!focusCancel"/);
  // The dialog layer honours [autofocus] before the first focusable control (×).
  assert.match(read("./dialogLayerManager.js"), /"\[autofocus\]",/);
});

test("F5 refreshes the focused home page or table and never reloads the window", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const handler = orchestrator.match(/function handleRefreshKeydown\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(handler, /shortcutHelper\.matchesBinding\("refresh", event\)/);
  // The SQL editor keeps F5 for running the query.
  assert.match(handler, /event\.target\?\.closest\?\.\("\.cm-editor"\)\) return false;/);
  assert.match(handler, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  // An in-progress cell edit is never thrown away by a refresh.
  assert.match(handler, /if \(focusedPaneState\.isEditing\?\.\(\)\) return true;/);
  assert.match(handler, /focusedPaneState\.refreshHomeView\?\.\(\)/);
  assert.match(handler, /refreshDataTab\(activeDataTab\.value\)/);
  assert.match(orchestrator, /if \(handleRefreshKeydown\(event\)\) return;/);
  assert.match(read("./components/WorkbenchPane.vue"), /refreshHomeView,/);
  assert.match(read("./components/DatabaseHome.vue"), /defineExpose\(\{ copySelection, pasteTables, focusSearch, refresh \}\)/);
});

test("home box selection replaces the selection, Ctrl/Cmd+drag adds to it", () => {
  const list = read("./components/DatabaseTableList.vue");

  assert.match(list, /const additive = Boolean\(event\.ctrlKey \|\| event\.metaKey\);\s*boxBaseNames\.value = additive \? \[\.\.\.props\.selectedNames\] : \[\];/);
  assert.match(list, /const selected = \[\.\.\.new Set\(\[\.\.\.boxBaseNames\.value, \.\.\.boxSelectedNames\.value\]\)\];/);
  // While dragging, a plain box shows only what it covers.
  assert.match(list, /const renderedSelectedSet = computed\(\(\) => \(boxPreviewActive\.value\s*\? new Set\(\[\.\.\.boxBaseNames\.value, \.\.\.boxSelectedNames\.value\]\)\s*: selectedSet\.value\)\);/);
  assert.match(list, /function handleBlankPointer\(event\)\s*\{[\s\S]*?if \(event\.ctrlKey \|\| event\.metaKey\) return;/);
});

test("context menus show the matching keys and support keyboard navigation", () => {
  const home = read("./components/DatabaseHome.vue");
  const menu = read("./components/ContextMenu.vue");
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.match(home, /class="wb-context-menu wb-dbhome-context-menu"[\s\S]*?@keydown="handleContextMenuKeydown"/);
  assert.match(home, /\{\{ openMenuLabel \}\}<kbd class="wb-context-shortcut" aria-hidden="true">\{\{ menuShortcuts\.open \}\}<\/kbd>/);
  assert.match(menu, /@contextmenu\.prevent\.stop\s*\n\s*@keydown="handleKeydown"/);
  assert.match(menu, /defineExpose\(\{ focusFirstItem \}\)/);
  assert.match(orchestrator, /if \(event\?\.keyboard\) nextTick\(\(\) => contextMenuRef\.value\?\.focusFirstItem\?\.\(\)\)/);
  assert.match(styles, /\.wb-context-shortcut\s*\{[^}]*margin-left:\s*auto[^}]*color:\s*var\(--wb-quiet-text\)/s);
  // Hints are visual only: menu items keep their plain accessible names.
  for (const source of [home, menu, orchestrator]) {
    assert.doesNotMatch(source, /class="wb-context-shortcut"(?! aria-hidden="true")/);
  }
  assert.match(styles, /\.wb-table-item\.is-selected\s*\{[^}]*background:\s*var\(--wb-list-selected\)/s);
});

test("shortcut settings use localized labels and list the fixed list keys", () => {
  const dialog = read("./components/ShortcutSettingsDialog.vue");

  assert.match(dialog, /label: shortcutLabel\(action\)/);
  assert.doesNotMatch(dialog, /SHORTCUT_LABELS/);
  assert.match(dialog, /class="wb-shortcut-reference"/);
  for (const key of ["refOpen", "refDelete", "refRename", "refMultiSelect", "refSelectAll", "refContextMenu", "refCloseTab"]) {
    assert.match(dialog, new RegExp(`t\\("shortcut\\.${key}"\\)`));
  }
});

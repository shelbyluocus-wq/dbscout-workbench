import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { matchesShortcutCombo } from "./composables/useShortcuts.js";

const source = readFileSync(new URL("./components/DatabaseHome.vue", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("function handleEditTableCommentKeydown("), source.indexOf("function sendSelection("));

function harness({ selected = ["a"], focused = "a", allowed = true, menu = { open: false }, editable = false, binding = "F3" } = {}) {
  const calls = [];
  const run = runInNewContext(`${handler}; handleEditTableCommentKeydown`, {
    shortcuts: { matchesBinding: (_, event) => matchesShortcutCombo(binding, event) },
    canTableDesign: { value: allowed },
    isEditableTypeaheadTarget: () => editable,
    controller: { focusedName: { value: focused }, selectedSet: { value: new Set(selected) }, selectedNames: { value: selected } },
    menu,
    editTableComment: (name) => calls.push(name),
  });
  const event = { key: "F3", preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  return { run, calls, event };
}

test("home comment shortcut edits the selection or focused selected table", () => {
  for (const options of [{}, { selected: ["a", "b"], focused: "b" }, { focused: "stale" }]) {
    const h = harness(options);
    assert.equal(h.run(h.event), true);
    assert.deepEqual(h.calls, [options.focused === "b" ? "b" : "a"]);
    assert.equal(h.event.prevented, true);
    assert.equal(h.event.stopped, true);
  }
});

test("the open context menu targets its table rather than the previous focused row", () => {
  const h = harness({ menu: { open: true, tableName: "b" } });
  assert.equal(h.run(h.event), true);
  assert.deepEqual(h.calls, ["b"]);
});

test("no selection, blank menu, unsupported connection, text editing and other bindings do not edit", () => {
  for (const options of [
    { selected: [] }, { menu: { open: true, tableName: "" } },
    { allowed: false }, { editable: true }, { binding: "Ctrl+E" },
  ]) {
    const h = harness(options);
    assert.equal(h.run(h.event), false);
    assert.deepEqual(h.calls, []);
    assert.equal(h.event.prevented, undefined);
  }
});

test("home list and context menu both route the configurable comment shortcut", () => {
  assert.match(source, /function handleHomeListKeydown\(event\) \{\s*if \(!isHomeListCommandTarget\(event.target\)\) return false;\s*if \(handleEditTableCommentKeydown\(event\)\) return true;/);
  assert.match(source, /function handleContextMenuKeydown\(event\) \{\s*if \(handleEditTableCommentKeydown\(event\)\) return;/);
  assert.match(source, /editTableComment: formatShortcutForPlatform\(shortcuts.get\("editTableComment"\)\)/);
  assert.match(source, /<kbd v-if="menuShortcuts.editTableComment"[^>]*>\{\{ menuShortcuts.editTableComment \}\}<\/kbd>/);
});

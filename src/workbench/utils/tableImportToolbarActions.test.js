import test from "node:test";
import assert from "node:assert/strict";

import {
  createTableImportToolbarActions,
  resolveTableImportToolbarEvent,
} from "./tableImportToolbarActions.js";

test("table import toolbar keeps batch import primary and current-table import in the menu", () => {
  const actions = createTableImportToolbarActions({ hasSession: true });

  assert.equal(actions.menuLabel, "Import options");
  assert.deepEqual(
    actions.compactItems.map(({ id, label }) => ({ id, label })),
    [
      { id: "batch-import", label: "Batch import" },
      { id: "import-current", label: "Import" },
    ],
  );
  assert.equal(actions.primary.id, "batch-import");
  assert.equal(actions.menuItems[0].id, "import-current");
  assert.equal(resolveTableImportToolbarEvent(actions.primary.id), "batch-import");
  assert.equal(resolveTableImportToolbarEvent(actions.menuItems[0].id), "import");
  assert.equal(resolveTableImportToolbarEvent("unknown"), "");
});

test("table import toolbar applies busy, session, and read-only states to the correct action", () => {
  const cases = [
    { state: { hasSession: true }, primaryDisabled: false, menuDisabled: false },
    { state: { hasSession: false }, primaryDisabled: false, menuDisabled: true },
    { state: { busy: true, hasSession: true }, primaryDisabled: true, menuDisabled: true },
    { state: { readOnly: true, hasSession: true }, primaryDisabled: true, menuDisabled: true },
    { state: { canImport: false, hasSession: true }, primaryDisabled: true, menuDisabled: true },
  ];

  for (const { state, primaryDisabled, menuDisabled } of cases) {
    const actions = createTableImportToolbarActions(state);
    assert.equal(actions.primary.disabled, primaryDisabled, JSON.stringify(state));
    assert.equal(actions.menuItems[0].disabled, menuDisabled, JSON.stringify(state));
    assert.equal(actions.compactItems[0].disabled, primaryDisabled, JSON.stringify(state));
    assert.equal(actions.compactItems[1].disabled, menuDisabled, JSON.stringify(state));
  }
});


test("table import toolbar translates owned copy without changing action IDs", async () => {
  const { default: zh } = await import("../i18n/zhCN.js");
  const actions = createTableImportToolbarActions({ hasSession: true, translate: (key) => zh[key] });
  assert.equal(actions.primary.label, "批量导入");
  assert.equal(actions.menuItems[0].label, "导入");
  assert.equal(actions.primary.id, "batch-import");
  assert.equal(actions.menuItems[0].disabled, false);
});

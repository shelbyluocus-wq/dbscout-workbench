# Table Toolbar Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose current-table import/export and pane-splitting actions beside table search, with consistent split-button dropdowns for batch and directional choices.

**Architecture:** Add one reusable `ToolbarSplitButton` component that owns trigger semantics, viewport-safe Teleport placement, keyboard dismissal, and shared menu rendering. `DataGrid` owns which toolbar menu is open and emits action intent; `WorkbenchPane` keeps ownership of the existing commands and retains its fallback overflow menu for design and empty panes.

**Tech Stack:** Vue 3 `<script setup>`, CSS custom properties in `workbench.css`, Node `node:test`, Playwright browser verification.

---

## File Structure

- Create `src/workbench/components/ToolbarSplitButton.vue`: reusable label/caret control and floating menu.
- Create `src/workbench/tableToolbarActions.test.js`: focused static contract tests for markup, wiring, and CSS.
- Modify `src/workbench/components/DataGrid.vue`: render the four controls and emit action intent.
- Modify `src/workbench/components/WorkbenchPane.vue`: connect grid events to existing actions while keeping non-data fallback actions.
- Modify `src/workbench/workbench.css`: shared split-button and floating-menu styling, responsive behavior, and reduced motion.

### Task 1: Lock The Toolbar Contract

**Files:**
- Create: `src/workbench/tableToolbarActions.test.js`

- [ ] **Step 1: Write the failing structural tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("data table toolbar exposes direct actions and dropdown choices", () => {
  const grid = read("./components/DataGrid.vue");
  assert.match(grid, /ToolbarSplitButton/);
  assert.match(grid, /label="导出"[\s\S]*?@primary="emit\('export'\)"/);
  assert.match(grid, /label="导入"[\s\S]*?@primary="emit\('import'\)"/);
  assert.match(grid, /label="分屏"[\s\S]*?@primary="emit\('split-pane', 'right'\)"/);
  assert.match(grid, /批量导出/);
  assert.match(grid, /批量导入/);
  assert.match(grid, /左右分屏/);
  assert.match(grid, /上下分屏/);
  assert.doesNotMatch(grid, /wb-split-more-btn/);
});

test("toolbar dropdowns share one accessible floating menu component", () => {
  const component = read("./components/ToolbarSplitButton.vue");
  const styles = read("./workbench.css");
  assert.match(component, /<Teleport to="body">/);
  assert.match(component, /role="menu"/);
  assert.match(component, /aria-haspopup="menu"/);
  assert.match(component, /aria-expanded/);
  assert.match(component, /Escape/);
  assert.match(styles, /\.wb-toolbar-split-button/);
  assert.match(styles, /\.wb-toolbar-action-menu/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("workbench pane wires table actions and preserves non-data fallback menu", () => {
  const pane = read("./components/WorkbenchPane.vue");
  assert.match(pane, /@export="triggerExport"/);
  assert.match(pane, /@import="triggerImport"/);
  assert.match(pane, /@batch-export="batchExportFromMenu"/);
  assert.match(pane, /@batch-import="batchImportFromMenu"/);
  assert.match(pane, /@split-pane="splitPaneFromToolbar"/);
  assert.match(pane, /v-else-if="activeDesignTab"[\s\S]*?wb-split-more-btn/);
  assert.match(pane, /v-else[\s\S]*?wb-pane-empty-actions[\s\S]*?wb-split-more-btn/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/workbench/tableToolbarActions.test.js`

Expected: FAIL because `ToolbarSplitButton.vue` and the new toolbar wiring do not exist.

### Task 2: Build The Shared Split Button

**Files:**
- Create: `src/workbench/components/ToolbarSplitButton.vue`
- Test: `src/workbench/tableToolbarActions.test.js`

- [ ] **Step 1: Implement the reusable component**

The component accepts `label`, `open`, `items`, `disabled`, `menuLabel`, and `primaryOpensMenu`. It emits `primary`, `toggle`, `close`, and `select`. Use two adjacent buttons: the label invokes the direct action unless `primaryOpensMenu` is true, while the caret always toggles the menu.

```vue
<ToolbarSplitButton
  label="导出"
  :open="openMenu === 'export'"
  :items="exportItems"
  @primary="emit('export')"
  @toggle="toggleToolbarMenu('export')"
  @select="handleToolbarAction"
/>
```

The floating menu must use `Teleport to="body"`, `position: fixed`, viewport clamping, menu semantics, first-item focus after opening, outside-pointer dismissal, Escape dismissal with focus restoration, and disabled-item guards.

- [ ] **Step 2: Run the focused test**

Run: `node --test src/workbench/tableToolbarActions.test.js`

Expected: toolbar integration assertions still fail, while component accessibility assertions pass.

### Task 3: Replace The Data-Table Overflow Entry

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Test: `src/workbench/tableToolbarActions.test.js`

- [ ] **Step 1: Add action events and menu models in DataGrid**

Add these emitted events:

```js
'export',
'import',
'batch-export',
'batch-import',
'split-pane',
```

Track `openToolbarMenu` as one nullable menu id. Define menu items with stable ids:

```js
const exportItems = [{ id: "batch-export", label: "批量导出", hint: "导出多张表" }];
const importItems = [{ id: "batch-import", label: "批量导入", hint: "导入多张表" }];
const splitItems = [
  { id: "split-right", label: "左右分屏", hint: "在右侧打开" },
  { id: "split-down", label: "上下分屏", hint: "在下方打开" },
];
```

The match items use `checked` for the current mode. Selecting an item updates the mode or emits the corresponding action, then closes the menu.

- [ ] **Step 2: Render controls in the required order**

Keep status indicators before one trailing action group. Render match mode, export, import, and split controls adjacent in that order. Remove the data-grid `wb-split-more-btn`.

Disable direct import when `busy`, no session exists, or the active tab is read-only. Disable batch import when `busy` or read-only. Preserve current export and split availability rules.

- [ ] **Step 3: Wire WorkbenchPane to existing command owners**

Add:

```js
function splitPaneFromToolbar(direction) {
  focusPane();
  emit("split-pane", props.pane.id, direction);
}
```

Connect DataGrid events to `triggerExport`, `triggerImport`, `batchExportFromMenu`, `batchImportFromMenu`, and `splitPaneFromToolbar`. Keep the existing floating overflow menu only for table-design and empty-pane views.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test src/workbench/tableToolbarActions.test.js`

Expected: PASS.

### Task 4: Apply One Visual And Responsive System

**Files:**
- Modify: `src/workbench/workbench.css`
- Test: `src/workbench/tableToolbarActions.test.js`

- [ ] **Step 1: Add shared styles**

Add a trailing `.wb-table-toolbar-actions` flex group and shared styles for:

```css
.wb-toolbar-split-button {}
.wb-toolbar-split-button-main {}
.wb-toolbar-split-button-caret {}
.wb-toolbar-action-menu {}
.wb-toolbar-action-menu-item {}
.wb-toolbar-action-menu-check {}
.wb-toolbar-action-menu-copy {}
.wb-toolbar-action-menu-hint {}
```

Use existing `--wb-*` colors, 28px stable trigger height, 6px trigger radius, 8px menu radius, the established floating border/shadow tokens, clear hover/focus/expanded states, and no decorative animation. Use a 140–180ms ease-out opening transition and disable transform motion under `prefers-reduced-motion: reduce`.

- [ ] **Step 2: Remove superseded filter-menu styles**

Delete `.wb-filter-mode-menu*` rules after the new component covers match mode. Keep only mode-specific text state needed by the new trigger.

- [ ] **Step 3: Run focused and shell tests**

Run: `node --test src/workbench/tableToolbarActions.test.js src/workbench/workbenchShell.test.js`

Expected: PASS. If a pre-existing shell assertion expects the data-grid overflow button, update only that assertion to distinguish data-table removal from design/empty fallback retention.

### Task 5: Build And Browser-Verify

**Files:**
- Modify only if verification exposes a defect in the files above.

- [ ] **Step 1: Run all focused frontend verification**

Run: `node scripts/test-workbench.mjs`

Expected: PASS, or report unrelated pre-existing failures separately with the focused toolbar test still passing.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: Vite and sidecar build complete without errors.

- [ ] **Step 3: Start the browser development server**

Run: `npm run dev`

Expected: the app is available on the printed localhost URL (normally port 1431; use another port if occupied).

- [ ] **Step 4: Verify the UI with Playwright**

Check light and dark themes at approximately 1440x900 and a narrow center-pane width. Confirm direct actions, one-open-menu behavior, Escape/outside dismissal, read-only disabled import, menu viewport containment, horizontal toolbar scrolling, and no overlap or clipping. Capture screenshots for the final verification record.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only planned files plus pre-existing user changes are present.

### Task 6: Resolve Freeze Targets From Live Grid Selection

**Files:**
- Create: `src/workbench/utils/freezeSelection.js`
- Create: `src/workbench/utils/freezeSelection.test.js`

- [ ] **Step 1: Write failing selection-resolution tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveFreezeTarget } from "./freezeSelection.js";

test("full-column selection freezes through the selected column only", () => {
  assert.deepEqual(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: {
      tabId: "tab-1",
      anchor: { rowIndex: 0, columnIndex: 1 },
      focus: { rowIndex: 9, columnIndex: 1 },
    },
  }), {
    kind: "column",
    rowIndex: 9,
    columnIndex: 1,
    freezeRows: 0,
    freezeColumns: 2,
  });
});

test("cell selection freezes through the active row and column", () => {
  assert.deepEqual(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: {
      tabId: "tab-1",
      anchor: { rowIndex: 2, columnIndex: 3 },
      focus: { rowIndex: 2, columnIndex: 3 },
    },
  }), {
    kind: "cell",
    rowIndex: 2,
    columnIndex: 3,
    freezeRows: 3,
    freezeColumns: 4,
  });
});

test("missing or stale selection has no freeze target", () => {
  assert.equal(resolveFreezeTarget({ tabId: "tab-1", rowCount: 10, selectedRange: null }), null);
  assert.equal(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: { tabId: "tab-2", anchor: {}, focus: {} },
  }), null);
});
```

- [ ] **Step 2: Run the helper test and verify RED**

Run: `node --test src/workbench/utils/freezeSelection.test.js`

Expected: FAIL because `freezeSelection.js` does not exist.

- [ ] **Step 3: Implement the pure resolver**

```js
export function resolveFreezeTarget({ tabId, rowCount, selectedRange }) {
  if (!tabId || selectedRange?.tabId !== tabId || rowCount <= 0) return null;
  const anchor = selectedRange.anchor;
  const focus = selectedRange.focus;
  const rowIndex = Number(focus?.rowIndex);
  const columnIndex = Number(focus?.columnIndex);
  const anchorRow = Number(anchor?.rowIndex);
  const anchorColumn = Number(anchor?.columnIndex);
  if (![rowIndex, columnIndex, anchorRow, anchorColumn].every(Number.isInteger)) return null;
  if (rowIndex < 0 || columnIndex < 0 || anchorRow < 0 || anchorColumn < 0) return null;

  const coversAllRows = Math.min(anchorRow, rowIndex) === 0
    && Math.max(anchorRow, rowIndex) >= rowCount - 1;
  const rightmostColumn = Math.max(anchorColumn, columnIndex);
  return {
    kind: coversAllRows ? "column" : "cell",
    rowIndex,
    columnIndex,
    freezeRows: coversAllRows ? 0 : rowIndex + 1,
    freezeColumns: (coversAllRows ? rightmostColumn : columnIndex) + 1,
  };
}
```

- [ ] **Step 4: Run the helper test and verify GREEN**

Run: `node --test src/workbench/utils/freezeSelection.test.js`

Expected: PASS.

### Task 7: Add Freeze Between Match Mode And Export

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/ToolbarSplitButton.vue`
- Modify: `src/workbench/tableToolbarActions.test.js`
- Test: `src/workbench/utils/freezeSelection.test.js`

- [ ] **Step 1: Extend the toolbar contract test and verify RED**

Add assertions that `label="冻结"` appears after the match-mode control and before `label="导出"`, that its direct action calls `applyDefaultFreeze`, and that the menu includes all six existing freeze choices.

Run: `node --test src/workbench/tableToolbarActions.test.js`

Expected: FAIL because the freeze control is not rendered.

- [ ] **Step 2: Build reactive freeze items in DataGrid**

Import `resolveFreezeTarget`. Derive the current target from `tab.id`, `tabRowCount(tab)`, and `selectedRange`. Build menu items for current cell, current row, current column, first row, first column, and unfreeze. Keep unavailable current-selection actions visible with `disabled: true`.

```js
const freezeTarget = computed(() => resolveFreezeTarget({
  tabId: props.tab?.id,
  rowCount: tabRowCount(props.tab),
  selectedRange: props.selectedRange,
}));
const freezeItems = computed(() => ([
  { id: "freeze-cell", label: "冻结到当前单元格", disabled: freezeTarget.value?.kind !== "cell", icon: "freeze-cell" },
  { id: "freeze-row", label: "冻结到当前行", disabled: freezeTarget.value?.kind !== "cell", icon: "freeze-row" },
  { id: "freeze-column", label: "冻结到当前列", disabled: !freezeTarget.value, icon: "freeze-column" },
  { id: "freeze-top-row", label: "冻结首行", icon: "freeze-row" },
  { id: "freeze-first-column", label: "冻结首列", icon: "freeze-column" },
  { id: "unfreeze", label: "取消冻结", disabled: !hasFreeze.value, icon: "unfreeze" },
]));
```

- [ ] **Step 3: Implement direct and menu freeze mutations**

The direct handler returns immediately when `freezeTarget` is null. For valid targets, clear the current freeze and apply the resolved row/column counts. Menu actions apply cell, row-only, column-only, first-row, first-column, or clear operations through `useFreezePanes`.

- [ ] **Step 4: Render the shared split button in order**

Render `ToolbarSplitButton` with label `冻结`, active state from `hasFreeze`, direct handler `applyDefaultFreeze`, menu id `freeze`, and the computed freeze items. Place it immediately after match mode and before export.

- [ ] **Step 5: Add freeze item icons to the shared menu component**

Add restrained grid/row/column/unfreeze SVG branches using the component's existing 16px stroke icon vocabulary. Do not add a new dependency or freeze-specific menu surface.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test src/workbench/utils/freezeSelection.test.js src/workbench/tableToolbarActions.test.js`

Expected: PASS.

### Task 8: Verify Freeze Toolbar Integration

**Files:**
- Modify only if verification exposes a defect in the files above.

- [ ] **Step 1: Run freeze, toolbar, and shell tests**

Run: `node --test src/workbench/utils/freezeSelection.test.js src/workbench/tableToolbarActions.test.js src/workbench/useVirtualGrid.test.js`

Expected: PASS.

- [ ] **Step 2: Run the full frontend suite**

Run: `node scripts/test-workbench.mjs`

Expected: all toolbar/freeze tests pass; report the previously recorded theme assertion separately if it remains.

- [ ] **Step 3: Build and browser-verify**

Run: `npm run build`, then verify the local app at desktop and narrow widths. Confirm toolbar order, no-selection no-op, column and cell defaults, all menu choices, active freeze styling, Escape/outside dismissal, and viewport-contained menus.

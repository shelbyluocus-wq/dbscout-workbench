# Tab-bar window drag + column header selection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workbench tab bar draggable to move the application window and unify its styling with the toolbar row, and let users select an entire table column by clicking its header.

**Architecture:** Both features are isolated UI changes in `src/workbench/`. Feature 1 extracts tab-bar drag logic into a small composable (`useTabWindowDrag.js`) and wires it into `WorkbenchTabs.vue`; the composable delegates to Tauri v2 `getCurrentWindow().startDragMove()` when the pointer drags on empty tab-bar space. Feature 2 extends `useGridEditor.js` with column-selection state stored as a normal cell range, so existing keyboard/copy/paste behavior works without extra wiring. Events flow from `DataGrid.vue` through `WorkbenchPane.vue`/`MySqlWorkbench.vue` into the editor composable.

**Tech stack:** Vue 3 Composition API, Tauri v2 (`@tauri-apps/api/window`), Node.js built-in test runner, existing CSS custom properties.

**Subagent split:**
- Subagent A: Feature 1 (tab-bar drag + styling).
- Subagent B: Feature 2 (column selection).
- Controller (this session): sets up worktree, hands off plan excerpts, runs final verification.

---

## Task 0: Create isolated worktree and verify baseline

**Files:**
- Use: git

- [ ] **Step 1: Create a worktree from the current branch**

Run:
```bash
cd /e/project/dbscout-workbench
mkdir -p .worktrees
git worktree add .worktrees/tab-column-selection -b feature/tab-column-selection
```

- [ ] **Step 2: Switch into the worktree and run the JS test baseline**

Run:
```bash
cd /e/project/dbscout-workbench/.worktrees/tab-column-selection
node --test src/workbench
```

Expected: All existing tests pass. Record the pass count.

- [ ] **Step 3: Run the frontend build smoke check**

Run:
```bash
npm run build
```

Expected: Build completes with exit code 0.

---

## Subagent A: Tab-bar window drag + unified styling

**Scope:** Only the tab bar and its surrounding header styling. Do not touch grid selection.

**Files:**
- Create: `src/workbench/composables/useTabWindowDrag.js`
- Create: `src/workbench/composables/useTabWindowDrag.test.js`
- Modify: `src/workbench/components/WorkbenchTabs.vue`
- Modify: `src/workbench/workbench.css`

### Step 1: Write failing test for useTabWindowDrag

Create `src/workbench/composables/useTabWindowDrag.test.js`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { reactive, ref } from "vue";
import { useTabWindowDrag } from "./useTabWindowDrag.js";

function createPointerEnv() {
  const startDragMove = () => { startDragMove.calls += 1; };
  startDragMove.calls = 0;
  return {
    startDragMove,
    events: [],
    addEvent(type, handler) { this.events.push({ type, handler }); },
    removeEvent(type, handler) { this.events = this.events.filter((e) => e.type !== type || e.handler !== handler); },
  };
}

test("dragging past threshold on tab-bar background starts window drag", () => {
  const env = createPointerEnv();
  const tabBar = { value: document.createElement("section") };
  const { onTabBarMouseDown } = useTabWindowDrag(tabBar, env.startDragMove, env);

  const mousedown = { button: 0, clientX: 100, clientY: 10, target: tabBar.value };
  onTabBarMouseDown(mousedown);

  const mousemove = { button: 0, clientX: 110, clientY: 20 };
  env.events.find((e) => e.type === "mousemove").handler(mousemove);

  assert.equal(env.startDragMove.calls, 1);
});

test("dragging on a tab element does not start window drag", () => {
  const env = createPointerEnv();
  const tabBar = { value: document.createElement("section") };
  const tab = document.createElement("div");
  tab.className = "wb-tab";
  tabBar.value.appendChild(tab);
  const { onTabBarMouseDown } = useTabWindowDrag(tabBar, env.startDragMove, env);

  const mousedown = { button: 0, clientX: 100, clientY: 10, target: tab };
  onTabBarMouseDown(mousedown);

  const mousemove = { button: 0, clientX: 110, clientY: 20 };
  env.events.find((e) => e.type === "mousemove").handler(mousemove);

  assert.equal(env.startDragMove.calls, 0);
});
```

Run:
```bash
node --test src/workbench/composables/useTabWindowDrag.test.js
```

Expected: FAIL — `useTabWindowDrag` does not exist.

### Step 2: Implement useTabWindowDrag composable

Create `src/workbench/composables/useTabWindowDrag.js`:

```javascript
import { onBeforeUnmount, onMounted, ref } from "vue";

export function useTabWindowDrag(tabBarRef, startDragMove, windowApi = window) {
  const dragStart = ref(null);
  const threshold = 4;

  function isTabElement(target) {
    return Boolean(target?.closest?.(".wb-tab"));
  }

  function onTabBarMouseDown(event) {
    if (event.button !== 0) return;
    if (isTabElement(event.target)) return;
    dragStart.value = { x: event.clientX, y: event.clientY };
  }

  function onWindowMouseMove(event) {
    if (!dragStart.value) return;
    const dx = Math.abs(event.clientX - dragStart.value.x);
    const dy = Math.abs(event.clientY - dragStart.value.y);
    if (dx < threshold && dy < threshold) return;
    dragStart.value = null;
    if (typeof startDragMove === "function") {
      try {
        startDragMove();
      } catch {}
    }
  }

  function onWindowMouseUp() {
    dragStart.value = null;
  }

  onMounted(() => {
    windowApi.addEventListener("mousemove", onWindowMouseMove);
    windowApi.addEventListener("mouseup", onWindowMouseUp);
  });

  onBeforeUnmount(() => {
    windowApi.removeEventListener("mousemove", onWindowMouseMove);
    windowApi.removeEventListener("mouseup", onWindowMouseUp);
  });

  return { onTabBarMouseDown };
}
```

### Step 3: Verify composable tests pass

Run:
```bash
node --test src/workbench/composables/useTabWindowDrag.test.js
```

Expected: PASS.

### Step 4: Wire composable into WorkbenchTabs.vue

Modify `src/workbench/components/WorkbenchTabs.vue`:

1. Import:
```javascript
import { useTabWindowDrag } from "../composables/useTabWindowDrag.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
```

2. After the existing refs, add:
```javascript
const tabBarRef = ref(null);
useTabWindowDrag(
  tabBarRef,
  () => {
    try {
      getCurrentWindow().startDragMove();
    } catch {}
  },
);
```

3. Bind the ref to the root `<section>`:
```vue
<section
  ref="tabBarRef"
  class="wb-object-tabs wb-tabs"
  @mousedown="onTabBarMouseDown"
  ...
>
```

4. Note: `onTabBarMouseDown` is returned by the composable and must be available in the template. Either destructure it or return it from setup.

### Step 5: Unify tab strip styling

Modify `src/workbench/workbench.css`:

1. Find `.wb-object-tabs` and set:
```css
.wb-object-tabs {
  background: var(--wb-toolbar-surface);
  border-bottom: none;
  /* keep existing padding/flex rules */
}
```

2. Find `.wb-tab` inactive styles and make the background transparent:
```css
.wb-tab {
  background: transparent;
  /* keep existing borders/text styles */
}
```

3. Ensure `.wb-tab.active` keeps:
```css
.wb-tab.active {
  background: var(--wb-tab-active);
}
```

4. Remove or reduce any box-shadow/border between `.wb-object-tabs` and `.wb-table-toolbar` so the two rows visually merge.

### Step 6: Run tests and build for Feature 1

Run:
```bash
node --test src/workbench/composables/useTabWindowDrag.test.js
node --test src/workbench
npm run build
```

Expected: All pass.

### Step 7: Commit Feature 1

Run:
```bash
git add src/workbench/composables/useTabWindowDrag.js src/workbench/composables/useTabWindowDrag.test.js src/workbench/components/WorkbenchTabs.vue src/workbench/workbench.css
git commit -m "feat(tabs): drag window from tab-bar empty space and unify header styling"
```

---

## Subagent B: Column header click selects whole column

**Scope:** Only grid column selection. Do not touch tab bar code.

**Files:**
- Modify: `src/workbench/composables/useGridEditor.js`
- Modify: `src/workbench/useGridEditor.test.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

### Step 1: Write failing test for selectColumn

Add to `src/workbench/useGridEditor.test.js`:

```javascript
test("selectColumn selects all cells in the clicked column", () => {
  const { editor, tab } = createEditor();
  editor.selectColumn(tab, "level");
  assert.equal(editor.selectedRange.value.anchor.columnIndex, 1);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 1);
  assert.equal(editor.selectedRange.value.anchor.rowIndex, 0);
  assert.equal(editor.selectedRange.value.focus.rowIndex, tab.rows.length - 1);
});
```

Run:
```bash
node --test src/workbench/useGridEditor.test.js
```

Expected: FAIL — `selectColumn` is not a function.

### Step 2: Add column selection state and helpers to useGridEditor.js

Modify `src/workbench/composables/useGridEditor.js`:

1. Add state near the other refs:
```javascript
const selectedColumnAnchor = ref(-1);
const selectedColumnSet = ref(new Set());
```

2. Add helper to compute last selectable row index:
```javascript
function lastSelectableRowIndex(tab) {
  return selectableRowCount(tab) - 1;
}
```

3. Add `columnIndexByName`:
```javascript
function columnIndexByName(name) {
  return activeColumns.value.findIndex((col) => columnName(col) === name);
}
```

4. Add `setColumnRange`:
```javascript
function setColumnRange(tab, columnIndex) {
  const colName = columnName(activeColumns.value[columnIndex]);
  const topRow = positionFromIndexes(tab, 0, columnIndex);
  const bottomRow = positionFromIndexes(tab, lastSelectableRowIndex(tab), columnIndex);
  if (!topRow || !bottomRow) return;
  selectedRange.value = { tabId: tab.id, anchor: topRow.position, focus: bottomRow.position };
  selectedCell.value = { tabId: tab.id, rowKey: topRow.position.rowKey, column: colName };
}
```

5. Add `clearColumnSelection`:
```javascript
function clearColumnSelection() {
  selectedColumnAnchor.value = -1;
  selectedColumnSet.value.clear();
}
```

6. Add `updateColumnRangeFromSet`:
```javascript
function updateColumnRangeFromSet(tab) {
  const indices = [...selectedColumnSet.value].sort((a, b) => a - b);
  if (indices.length === 0) {
    clearSelection();
    return;
  }
  const first = indices[0];
  const last = indices.at(-1);
  const topLeft = positionFromIndexes(tab, 0, first);
  const bottomRight = positionFromIndexes(tab, lastSelectableRowIndex(tab), last);
  if (!topLeft || !bottomRight) return;
  selectedRange.value = { tabId: tab.id, anchor: topLeft.position, focus: bottomRight.position };
  selectedCell.value = { tabId: tab.id, rowKey: topLeft.position.rowKey, column: topLeft.position.column };
}
```

7. Add `selectColumn`:
```javascript
function selectColumn(tab, columnNameValue, event) {
  if (isSelectingRange.value || editingCell.value) return;
  const columnIndex = columnIndexByName(columnNameValue);
  if (columnIndex < 0) return;

  if (event?.shiftKey && selectedColumnAnchor.value >= 0) {
    const [from, to] = [selectedColumnAnchor.value, columnIndex].sort((a, b) => a - b);
    selectedColumnSet.value.clear();
    for (let i = from; i <= to; i++) selectedColumnSet.value.add(i);
    updateColumnRangeFromSet(tab);
    return;
  }

  if (event?.ctrlKey || event?.metaKey) {
    if (selectedColumnSet.value.has(columnIndex)) {
      selectedColumnSet.value.delete(columnIndex);
    } else {
      selectedColumnSet.value.add(columnIndex);
      if (selectedColumnAnchor.value < 0) selectedColumnAnchor.value = columnIndex;
    }
    updateColumnRangeFromSet(tab);
    return;
  }

  clearColumnSelection();
  selectedColumnSet.value.add(columnIndex);
  selectedColumnAnchor.value = columnIndex;
  setColumnRange(tab, columnIndex);
}
```

8. Add `isColumnSelected`:
```javascript
function isColumnSelected(tab, columnIndex) {
  const range = selectedRange.value;
  if (!tab || !range || range.tabId !== tab.id) return false;
  const left = Math.min(range.anchor.columnIndex, range.focus.columnIndex);
  const right = Math.max(range.anchor.columnIndex, range.focus.columnIndex);
  return columnIndex >= left && columnIndex <= right;
}
```

9. Update `clearSelection` to call `clearColumnSelection()`.

10. Expose `selectColumn` and `isColumnSelected` in the return object.

### Step 3: Verify single-column test

Run:
```bash
node --test src/workbench/useGridEditor.test.js
```

Expected: PASS, including the new test.

### Step 4: Add multi-select tests

Add to `src/workbench/useGridEditor.test.js`:

```javascript
test("ctrl-click toggles columns into a multi-column selection", () => {
  const { editor, tab } = createEditor();
  editor.selectColumn(tab, "name");
  editor.selectColumn(tab, "guild", { ctrlKey: true });
  const bounds = editor.getRangeBounds(editor.selectedRange.value);
  assert.equal(bounds.left, 0);
  assert.equal(bounds.right, 2);
});

test("shift-click extends column selection from the anchor", () => {
  const { editor, tab } = createEditor();
  editor.selectColumn(tab, "name");
  editor.selectColumn(tab, "guild", { shiftKey: true });
  const bounds = editor.getRangeBounds(editor.selectedRange.value);
  assert.equal(bounds.left, 0);
  assert.equal(bounds.right, 2);
});
```

Run:
```bash
node --test src/workbench/useGridEditor.test.js
```

Expected: PASS.

### Step 5: Wire column header click in DataGrid.vue

Modify `src/workbench/components/DataGrid.vue`:

1. Add `'select-column'` to the `defineEmits` array.

2. Add a handler in `<script setup>`:
```javascript
function onColumnHeaderMouseDown(tab, name, event) {
  if (event.target.closest(".wb-col-resize") || event.target.closest(".wb-sort-menu")) return;
  emit("select-column", tab, name, event);
}
```

3. Update each `<th>`:
```vue
<th
  v-for="(column, columnIndex) in activeColumns"
  :key="columnName(column)"
  :style="colStyle(tab.id, columnName(column))"
  :data-column-index="columnIndex"
  :class="{
    'schema-search-match': isSchemaSearchColumn(column),
    'schema-search-active': isActiveSchemaSearchColumn(column),
    'col-selected': isColumnSelected(tab, columnIndex),
  }"
  @mousedown.left="onColumnHeaderMouseDown(tab, columnName(column), $event)"
>
```

### Step 6: Propagate select-column through WorkbenchPane.vue

Modify `src/workbench/components/WorkbenchPane.vue`:

1. Add `'select-column'` to `defineEmits`.
2. Destructure `isColumnSelected` from `editor`.
3. Pass `isColumnSelected` to `DataGrid`:
```vue
:is-column-selected="isColumnSelected"
```
4. Add event handler on `DataGrid`:
```vue
@select-column="(tab, column, event) => emit('select-column', tab, column, event)"
```

### Step 7: Propagate select-column through MySqlWorkbench.vue

Modify `src/workbench/MySqlWorkbench.vue`:

1. Find the `WorkbenchPane` usage(s) and add:
```vue
@select-column="(tab, column, event) => editor.selectColumn(tab, column, event)"
```

2. If there are multiple `WorkbenchPane` instances, add the handler to each.

### Step 8: Style selected column headers

Modify `src/workbench/workbench.css`:

```css
.wb-grid th.col-selected {
  background: var(--wb-row-selected);
  color: var(--wb-grid-heading);
}
```

### Step 9: Verify Feature 2 tests and build

Run:
```bash
node --test src/workbench/useGridEditor.test.js
node --test src/workbench
npm run build
```

Expected: All pass.

### Step 10: Commit Feature 2

Run:
```bash
git add src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js src/workbench/components/DataGrid.vue src/workbench/components/WorkbenchPane.vue src/workbench/MySqlWorkbench.vue src/workbench/workbench.css
git commit -m "feat(grid): select whole columns via header clicks with ctrl/shift multi-select"
```

---

## Task 5: Final verification and finishing

**Files:**
- All changed files

- [ ] **Step 1: Run full JS test suite**

Run:
```bash
node --test src/workbench
```

Expected: All tests pass.

- [ ] **Step 2: Run frontend build**

Run:
```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Use superpowers:finishing-a-development-branch**

After tests pass, invoke the finishing skill to present merge/PR options.

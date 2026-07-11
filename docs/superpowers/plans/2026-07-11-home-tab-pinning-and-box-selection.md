# Homepage Tab Pinning And Box Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the unique homepage tab first in its pane and allow homepage table box selection to start from comment and field-count cells.

**Architecture:** `workspaceState.js` owns a mutating homepage-order normalizer so creation, reordering, cross-pane movement, and restoration share one invariant. `WorkbenchTabs.vue` mirrors that invariant in drag affordances and preview, while `DatabaseTableList.vue` narrows its pointer-start exclusion to the table-name column.

**Tech Stack:** Vue 3 Composition API, JavaScript, Node.js `node:test`, CSS-free interaction changes.

---

## File Map

- `src/workbench/workspaceState.js`: define and apply the homepage-first state invariant.
- `src/workbench/workspaceState.test.js`: test creation, reorder, cross-pane movement, and restored-order normalization.
- `src/workbench/MySqlWorkbench.vue`: normalize reconstructed panes after workspace restoration.
- `src/workbench/components/WorkbenchTabs.vue`: disable homepage dragging and pin drag previews.
- `src/workbench/components/DatabaseTableList.vue`: allow box-selection starts from non-name row columns.
- `src/workbench/homepageInteraction.test.js`: verify restoration wiring, drag affordances, and the box-selection exclusion contract without touching unrelated shell tests.

### Task 1: Homepage-First Workspace Invariant

**Files:**
- Modify: `src/workbench/workspaceState.test.js`
- Modify: `src/workbench/workspaceState.js`

- [ ] **Step 1: Write failing state tests**

Add these tests to `workspaceState.test.js`:

```js
test("opening the homepage places it before existing table tabs", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const orders = openTableTab(state, { tableName: "orders" });
  const customers = openTableTab(state, { tableName: "customers" });

  const home = openDatabaseHomeTab(state);

  assert.deepEqual(state.tabs.map((tab) => tab.id), [home.id, orders.id, customers.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, orders.id, customers.id]);
});

test("table reordering cannot place a data tab before the homepage", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state);
  const orders = openTableTab(state, { tableName: "orders" });
  const customers = openTableTab(state, { tableName: "customers" });

  moveTableTab(state, customers.id, home.id, { position: "before" });
  moveTableTab(state, home.id, orders.id, { position: "after" });

  assert.deepEqual(state.tabs.map((tab) => tab.id), [home.id, orders.id, customers.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, orders.id, customers.id]);
});

test("moving the homepage to another pane places it first there", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state, {}, { paneId: "pane-1" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const orders = openTableTab(state, { tableName: "orders" }, { paneId: "pane-2" });

  moveTabBetweenPanes(state, home.id, "pane-2", {
    targetTabId: orders.id,
    position: "after",
    activate: true,
  });

  assert.deepEqual(state.panes["pane-1"].tabIds, []);
  assert.deepEqual(state.panes["pane-2"].tabIds, [home.id, orders.id]);
  assert.equal(state.tabs.filter((tab) => tab.kind === "home").length, 1);
});

test("normalizeHomeTabOrder repairs restored order without changing active tabs", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state);
  const orders = openTableTab(state, { tableName: "orders" });
  const customers = openTableTab(state, { tableName: "customers" });
  state.tabs = [orders, customers, home];
  state.panes["pane-1"].tabIds = [orders.id, customers.id, home.id];
  state.panes["pane-1"].activeTabId = customers.id;
  state.activeTabId = customers.id;

  normalizeHomeTabOrder(state);

  assert.deepEqual(state.tabs.map((tab) => tab.id), [home.id, orders.id, customers.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, orders.id, customers.id]);
  assert.equal(state.panes["pane-1"].activeTabId, customers.id);
  assert.equal(state.activeTabId, customers.id);
});
```

Add `normalizeHomeTabOrder` to the existing workspace-state import list in the test.

- [ ] **Step 2: Run the new state tests and verify RED**

Run:

```bash
node --test --test-name-pattern="homepage places|cannot place|homepage to another pane|normalizeHomeTabOrder" src/workbench/workspaceState.test.js
```

Expected: FAIL because creation appends the homepage, reorder accepts positions before it, and `normalizeHomeTabOrder` is not exported.

- [ ] **Step 3: Implement the shared normalizer**

Add after the existing `isHomeTab` helper in `workspaceState.js`:

```js
export function normalizeHomeTabOrder(state) {
  if (!state?.tabs?.length) return null;
  const homeIndex = state.tabs.findIndex(isHomeTab);
  if (homeIndex < 0) return null;
  const home = state.tabs[homeIndex];
  if (homeIndex > 0) {
    state.tabs.splice(homeIndex, 1);
    state.tabs.unshift(home);
  }
  Object.values(state.panes || {}).forEach((pane) => {
    const paneHomeIndex = pane.tabIds?.indexOf(home.id) ?? -1;
    if (paneHomeIndex <= 0) return;
    pane.tabIds.splice(paneHomeIndex, 1);
    pane.tabIds.unshift(home.id);
  });
  return home;
}
```

- [ ] **Step 4: Apply the invariant at every state mutation boundary**

At the end of `attachTabToOnlyPane`, after active-tab handling, add:

```js
normalizeHomeTabOrder(state);
```

Before returning from `moveTableTab`, add:

```js
normalizeHomeTabOrder(state);
return source;
```

Before returning from `moveTabBetweenPanes`, add:

```js
normalizeHomeTabOrder(state);
return state.tabs.find((tab) => tab.id === tabId) || null;
```

The calls normalize both global and per-pane order without modifying focus or active IDs.

- [ ] **Step 5: Run the state test file and verify GREEN**

Run: `node --test src/workbench/workspaceState.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the state invariant**

```bash
git add src/workbench/workspaceState.js src/workbench/workspaceState.test.js
git commit -m "fix(workbench): pin homepage tab first"
```

### Task 2: Restoration And Drag Interaction Contract

**Files:**
- Create: `src/workbench/homepageInteraction.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/components/WorkbenchTabs.vue`

- [ ] **Step 1: Write a failing shell contract test**

Create `homepageInteraction.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(__dirname, path), "utf8");

test("homepage tab stays first across restoration and tab dragging", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");

  assert.match(orchestrator, /normalizeHomeTabOrder\(workspace\)/);
  assert.match(tabs, /:draggable="tabKind\(tab\) !== 'home'"/);
  assert.match(tabs, /function\s+pinHomeTabFirst\(tabs\)/);
  assert.match(tabs, /function\s+normalizeDropPosition\(tabId, position\)/);
  assert.match(tabs, /tabKind\(targetTab\)\s*===\s*["']home["']/);
  assert.match(tabs, /pinHomeTabFirst\(previewDragOrder/);
});
```

- [ ] **Step 2: Run the shell test and verify RED**

Run:

```bash
node --test --test-name-pattern="homepage tab stays first" src/workbench/homepageInteraction.test.js
```

Expected: FAIL because restoration normalization and pinned drag behavior are absent.

- [ ] **Step 3: Normalize restored panes**

Add `normalizeHomeTabOrder` to the workspace-state imports in `MySqlWorkbench.vue`.

Immediately after assigning `workspace.panes` during `restoreSavedTabs`, add:

```js
workspace.panes = restoredPaneState.panes;
normalizeHomeTabOrder(workspace);
workspace.layout = restoredPaneState.layout;
```

- [ ] **Step 4: Disable homepage dragging and pin preview order**

Add these helpers to `WorkbenchTabs.vue` after `tabKind`:

```js
function pinHomeTabFirst(tabs) {
  const homeIndex = tabs.findIndex((tab) => tabKind(tab) === "home");
  if (homeIndex <= 0) return tabs;
  const nextTabs = [...tabs];
  const [home] = nextTabs.splice(homeIndex, 1);
  nextTabs.unshift(home);
  return nextTabs;
}

function normalizeDropPosition(tabId, position) {
  const targetTab = props.tabs.find((tab) => tab.id === tabId);
  return tabKind(targetTab) === "home" && position === "before" ? "after" : position;
}
```

Change `previewTabs` to normalize both idle and drag-preview order:

```js
const previewTabs = computed(() => {
  if (!draggingTabId.value || !dragTargetTabId.value) return pinHomeTabFirst(props.tabs);
  return pinHomeTabFirst(previewDragOrder(props.tabs, draggingTabId.value, dragTargetTabId.value, {
    position: dragTargetPosition.value,
    getKey: (tab) => tab.id,
  }));
});
```

Change `markTabDragTarget` and the fallback in `dropTab` so both call:

```js
const position = normalizeDropPosition(tabId, tabDropPosition(event));
```

Change the template drag binding and drag-start argument:

```vue
:draggable="tabKind(tab) !== 'home'"
@dragstart.stop="startTabDrag(tab.id, $event)"
```

The existing browser drag event does not fire for the homepage when `draggable` is false; state normalization remains the final guard for programmatic moves.

- [ ] **Step 5: Run the shell and workspace tests**

Run:

```bash
node --test --test-name-pattern="homepage tab stays first" src/workbench/homepageInteraction.test.js
node --test src/workbench/workspaceState.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit restoration and drag behavior**

```bash
git add src/workbench/MySqlWorkbench.vue src/workbench/components/WorkbenchTabs.vue src/workbench/homepageInteraction.test.js
git commit -m "fix(workbench): keep homepage pinned during drag"
```

### Task 3: Homepage Box-Selection Start Surface

**Files:**
- Modify: `src/workbench/homepageInteraction.test.js`
- Modify: `src/workbench/components/DatabaseTableList.vue`

- [ ] **Step 1: Write a failing selection-start contract test**

Add to `homepageInteraction.test.js`:

```js
test("homepage box selection starts outside the table-name column", () => {
  const tableList = read("./components/DatabaseTableList.vue");
  const beginBoxSelection = tableList.match(/function\s+beginBoxSelection\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(beginBoxSelection, /\.wb-dbhome-object-name/);
  assert.match(beginBoxSelection, /\.wb-dbhome-table-header/);
  assert.match(beginBoxSelection, /\.wb-dbhome-empty-list/);
  assert.doesNotMatch(beginBoxSelection, /\.wb-dbhome-object-row/);
  assert.match(beginBoxSelection, /event\.preventDefault\(\)/);
  assert.match(tableList, /box\.width\s*<\s*4\s*\|\|\s*box\.height\s*<\s*4/);
});
```

- [ ] **Step 2: Run the selection contract and verify RED**

Run:

```bash
node --test --test-name-pattern="box selection starts outside" src/workbench/homepageInteraction.test.js
```

Expected: FAIL because `beginBoxSelection` excludes the entire object row.

- [ ] **Step 3: Narrow the box-selection exclusion selector**

Replace the exclusion in `beginBoxSelection`:

```js
function beginBoxSelection(event) {
  if (event.button !== 0) return;
  if (event.target?.closest?.(".wb-dbhome-object-name, .wb-dbhome-table-header, .wb-dbhome-empty-list")) return;
  if (props.renamingName) {
    renameInputRef.value?.blur?.();
    return;
  }
  const rect = scrollerRef.value?.getBoundingClientRect?.();
  if (!rect) return;
  event.preventDefault();
  boxSelectedNames.value = [];
  selectionBox.value = {
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    width: 0,
    height: 0,
  };
  window.addEventListener("pointermove", updateBoxSelection);
  window.addEventListener("pointerup", finishBoxSelection, { once: true });
}
```

- [ ] **Step 4: Run the shell test and verify GREEN**

Run:

```bash
node --test --test-name-pattern="box selection starts outside" src/workbench/homepageInteraction.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the box-selection interaction**

```bash
git add src/workbench/components/DatabaseTableList.vue src/workbench/homepageInteraction.test.js
git commit -m "fix(workbench): expand homepage box selection surface"
```

### Task 4: Final Verification

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run focused regression tests**

Run:

```bash
node --test src/workbench/workspaceState.test.js src/workbench/homepageInteraction.test.js src/workbench/utils/workspacePersistence.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: Vite production build succeeds.

- [ ] **Step 3: Verify the homepage in the browser**

At `http://127.0.0.1:1431/` confirm:

1. The homepage tab is first and cannot be dragged.
2. Dragging another tab toward the homepage cannot place it to the left.
3. Starting a drag on a comment selects intersected table rows.
4. Starting a drag on a field count selects intersected table rows.
5. Starting on the table-name column keeps its click/open behavior and does not begin a selection rectangle.

- [ ] **Step 4: Check final scope**

Run:

```bash
git diff --check HEAD~3..HEAD
git status --short
```

Expected: no whitespace errors; all pre-existing unrelated worktree changes remain uncommitted and absent from this feature's commits.

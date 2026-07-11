# Table Open Navigation Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent provisional table opens from stealing focus after navigation or becoming active while hidden, while preserving nonblocking table loading.

**Architecture:** `useTableSession` will synchronously invalidate activation intents when workspace navigation changes. A focused `tabPublication` utility will be the single definition of published pane tabs for rendering, active-content resolution, and keyboard cycling. Existing provisional request ownership remains unchanged.

**Tech Stack:** Vue 3 Composition API, JavaScript, Node.js `node:test`, CSS.

---

## File Map

- `src/workbench/composables/useTableSession.js`: invalidate pending activation intents when navigation changes.
- `src/workbench/useTableSession.test.js`: reproduce the database-switch race and verify the loaded table stays in the background.
- `src/workbench/utils/tabPublication.js`: define published pane tabs, published active content, and keyboard cycle targets.
- `src/workbench/utils/tabPublication.test.js`: verify provisional tabs are excluded from all published-tab consumers.
- `src/workbench/components/WorkbenchSplitLayout.vue`: render tabs and pane content from the shared publication helpers.
- `src/workbench/MySqlWorkbench.vue`: cycle only through published tabs and route keyboard activation through the normal activation handler.
- `src/workbench/workbenchShell.test.js`: verify publication-helper wiring and the cursor contract without replacing existing user edits.
- `src/workbench/workbench.css`: stop forcing the progress cursor onto every interactive descendant.

### Task 1: Invalidate Activation On Navigation

**Files:**
- Modify: `src/workbench/useTableSession.test.js`
- Modify: `src/workbench/composables/useTableSession.js`

- [ ] **Step 1: Write the failing database-navigation regression test**

Extend the workspace import in `useTableSession.test.js` with `openDatabaseHomeTab`, then add:

```js
test("database navigation prevents an older table open from stealing focus", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "old_db" });
  openDatabaseHomeTab(workspace, {
    connectionId: "mysql-1",
    database: "old_db",
  }, { activate: true });
  const page = deferred();
  const invoke = async (command) => {
    if (command === "open_table_session") return page.promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { statusText: ref("") });

  const opening = session.openTable({
    connectionId: "mysql-1",
    database: "old_db",
    tableName: "orders",
  });
  workspace.database = "new_db";
  const newHome = openDatabaseHomeTab(workspace, {
    connectionId: "mysql-1",
    database: "new_db",
  }, { activate: true });
  page.resolve({
    sessionId: "orders-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });

  const loaded = await opening;

  assert.equal(workspace.activeTabId, newHome.id);
  assert.equal(loaded.database, "old_db");
  assert.equal(loaded.opening, false);
  assert.deepEqual(loaded.rows, [{ id: 1 }]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test --test-name-pattern="database navigation prevents" src/workbench/useTableSession.test.js
```

Expected: FAIL because the loaded `old_db.orders` tab becomes `workspace.activeTabId`.

- [ ] **Step 3: Add synchronous navigation invalidation**

Inside `useTableSession`, after the activation-intent state is created, add:

```js
  const stopNavigationWatch = watch(
    () => [
      workspace.activeTabId,
      workspace.focusedPaneId,
      workspace.connectionId,
      workspace.database,
    ],
    () => activationIntentByPane.clear(),
    { flush: "sync" },
  );
```

Allow callers to invalidate one pane or every pane:

```js
  function cancelPendingTableActivation(paneId = "") {
    if (paneId) activationIntentByPane.delete(paneId);
    else activationIntentByPane.clear();
  }
```

In `dispose()`, stop the watcher and clear remaining intent state:

```js
    stopNavigationWatch();
    activationIntentByPane.clear();
```

- [ ] **Step 4: Run the new test and existing concurrency tests**

Run:

```bash
node --test --test-name-pattern="database navigation prevents|new table stays provisional|overlapping opens retain|explicit tab selection cancels" src/workbench/useTableSession.test.js
```

Expected: all selected tests PASS.

### Task 2: Use One Published-Tab Boundary

**Files:**
- Create: `src/workbench/utils/tabPublication.js`
- Create: `src/workbench/utils/tabPublication.test.js`
- Modify: `src/workbench/components/WorkbenchSplitLayout.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing utility tests**

Create `tabPublication.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  adjacentPublishedTabId,
  publishedActiveTabForPane,
  publishedTabsForPane,
} from "./tabPublication.js";

const tabs = [
  { id: "home", kind: "home" },
  { id: "opening", kind: "data", opening: true },
  { id: "ready", kind: "data", opening: false },
];
const pane = {
  id: "pane-1",
  tabIds: ["home", "opening", "ready"],
  activeTabId: "opening",
};

test("publishedTabsForPane excludes provisional tabs", () => {
  assert.deepEqual(publishedTabsForPane(tabs, pane).map((tab) => tab.id), ["home", "ready"]);
});

test("publishedActiveTabForPane rejects a provisional active tab", () => {
  assert.equal(publishedActiveTabForPane(tabs, pane), null);
});

test("adjacentPublishedTabId skips provisional tabs", () => {
  assert.equal(adjacentPublishedTabId(tabs, { ...pane, activeTabId: "home" }, "next"), "ready");
  assert.equal(adjacentPublishedTabId(tabs, { ...pane, activeTabId: "home" }, "previous"), "ready");
});
```

- [ ] **Step 2: Run the utility tests and verify RED**

Run:

```bash
node --test src/workbench/utils/tabPublication.test.js
```

Expected: FAIL because `tabPublication.js` does not exist.

- [ ] **Step 3: Implement the shared publication helpers**

Create `tabPublication.js`:

```js
export function isPublishedTab(tab) {
  return Boolean(tab) && tab.opening !== true;
}

export function publishedTabsForPane(tabs = [], pane = null) {
  const ids = new Set(pane?.tabIds || []);
  return tabs.filter((tab) => ids.has(tab?.id) && isPublishedTab(tab));
}

export function publishedActiveTabForPane(tabs = [], pane = null) {
  if (!pane?.activeTabId) return null;
  return publishedTabsForPane(tabs, pane).find((tab) => tab.id === pane.activeTabId) || null;
}

export function adjacentPublishedTabId(tabs = [], pane = null, direction = "next") {
  const published = publishedTabsForPane(tabs, pane);
  if (published.length < 2) return "";
  const activeIndex = published.findIndex((tab) => tab.id === pane?.activeTabId);
  if (direction === "previous") {
    return published[activeIndex <= 0 ? published.length - 1 : activeIndex - 1]?.id || "";
  }
  return published[activeIndex < 0 ? 0 : (activeIndex + 1) % published.length]?.id || "";
}
```

- [ ] **Step 4: Run the utility tests and verify GREEN**

Run:

```bash
node --test src/workbench/utils/tabPublication.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 5: Write failing shell wiring assertions**

Update the existing `provisional table opens stay hidden` test in `workbenchShell.test.js` to require:

```js
  assert.match(splitLayout, /publishedTabsForPane\(props\.tabs,\s*pane\)/);
  assert.match(splitLayout, /publishedActiveTabForPane\(props\.tabs,\s*pane\)/);
  assert.match(orchestrator, /adjacentPublishedTabId\(workspace\.tabs,\s*pane,\s*direction\)/);
  assert.match(orchestrator, /void\s+activateTab\(pane\.id,\s*nextTabId\)/);
```

Remove the older assertion that only checks an inline `!tab.opening` filter.

- [ ] **Step 6: Run the shell test and verify RED**

Run:

```bash
node --test --test-name-pattern="provisional table opens" src/workbench/workbenchShell.test.js
```

Expected: FAIL because the component and keyboard handler do not use the shared helpers.

- [ ] **Step 7: Wire pane rendering and keyboard cycling**

In `WorkbenchSplitLayout.vue`, import the helpers and replace the local functions:

```js
import {
  publishedActiveTabForPane,
  publishedTabsForPane,
} from "../utils/tabPublication.js";

function tabsForPane(pane) {
  return publishedTabsForPane(props.tabs, pane);
}

function activeTabForPane(pane) {
  return publishedActiveTabForPane(props.tabs, pane);
}
```

In `MySqlWorkbench.vue`, import `adjacentPublishedTabId` and replace `handleCycleTabKeydown` with:

```js
function handleCycleTabKeydown(event) {
  const pane = getFocusedPane(workspace);
  if (!pane) return false;
  const isNext = shortcutHelper.matchesBinding("nextTab", event);
  const isPrev = shortcutHelper.matchesBinding("previousTab", event);
  if (!isNext && !isPrev) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  const direction = isPrev ? "previous" : "next";
  const nextTabId = adjacentPublishedTabId(workspace.tabs, pane, direction);
  if (!nextTabId) return false;
  event.preventDefault();
  event.stopPropagation();
  void activateTab(pane.id, nextTabId);
  return true;
}
```

- [ ] **Step 8: Run utility and shell tests**

Run:

```bash
node --test src/workbench/utils/tabPublication.test.js src/workbench/workbenchShell.test.js
```

Expected: all tests in both files PASS.

### Task 3: Preserve Interactive Cursor Feedback

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Strengthen the cursor contract test**

In the existing provisional-open shell test, add:

```js
  assert.match(styles, /\.mysql-workbench\.is-opening-table\s*\{[\s\S]*?cursor:\s*progress/);
  assert.doesNotMatch(styles, /\.mysql-workbench\.is-opening-table\s+\*[\s\S]*?cursor:\s*progress\s*!important/);
```

- [ ] **Step 2: Run the shell test and verify RED**

Run:

```bash
node --test --test-name-pattern="provisional table opens" src/workbench/workbenchShell.test.js
```

Expected: FAIL because the current selector targets every descendant with `!important`.

- [ ] **Step 3: Limit the progress cursor to the root**

Replace the existing rule in `workbench.css` with:

```css
.mysql-workbench.is-opening-table {
  cursor: progress;
}
```

Do not rewrite adjacent style blocks or stage unrelated working-tree changes.

- [ ] **Step 4: Run the shell and CSS tests**

Run:

```bash
node --test src/workbench/workbenchShell.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: all tests PASS.

### Task 4: Final Verification

**Files:**
- No additional production changes expected.

- [ ] **Step 1: Run the focused regression set**

```bash
node --test src/workbench/useTableSession.test.js src/workbench/utils/tabPublication.test.js src/workbench/workspaceState.test.js src/workbench/utils/workspacePersistence.test.js src/workbench/useTableSearch.test.js src/workbench/useVirtualGrid.test.js src/workbench/workbenchShell.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Build the production frontend and sidecar**

```bash
npm run build
```

Expected: Vite and the agent sidecar build successfully. Existing chunk-size warnings are acceptable; errors are not.

- [ ] **Step 3: Inspect only the intended diff**

```bash
git diff --check
git status --short
git diff -- src/workbench/composables/useTableSession.js src/workbench/useTableSession.test.js src/workbench/utils/tabPublication.js src/workbench/utils/tabPublication.test.js src/workbench/components/WorkbenchSplitLayout.vue src/workbench/MySqlWorkbench.vue src/workbench/workbench.css src/workbench/workbenchShell.test.js
```

Expected: no whitespace errors; unrelated toolbar and grid edits remain present but unchanged by this implementation.

Because `workbench.css` and `workbenchShell.test.js` already contain user-owned changes, do not create an implementation commit automatically. Leave the scoped diff for explicit review or staging.


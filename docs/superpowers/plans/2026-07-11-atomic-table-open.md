# Atomic Table Opening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a new table tab and its fully populated grid appear together while the current table remains usable and a progress cursor acknowledges background loading.

**Architecture:** Keep provisional tabs in workspace state so existing duplicate detection and session ownership continue to work, but mark them `opening` and exclude them from rendering and persistence. `useTableSession` owns in-flight request reuse, a reference-counted opening indicator, and per-pane activation intent; the split layout and workbench root only consume those states.

**Tech Stack:** Vue 3 Composition API, JavaScript, Node.js `node:test`, CSS.

---

## File Map

- `src/workbench/composables/useTableSession.js`: own provisional open lifecycle, request reuse, activation intent, and opening count.
- `src/workbench/useTableSession.test.js`: verify asynchronous state transitions, concurrency, reuse, and failure cleanup.
- `src/workbench/workspaceState.js`: allow a provisional tab to be removed without changing pane focus.
- `src/workbench/workspaceState.test.js`: verify non-focusing tab removal.
- `src/workbench/utils/workspacePersistence.js`: exclude provisional tabs from saved snapshots.
- `src/workbench/utils/workspacePersistence.test.js`: verify incomplete tabs and pane references are not persisted.
- `src/workbench/components/WorkbenchSplitLayout.vue`: hide tabs whose first page is not ready.
- `src/workbench/MySqlWorkbench.vue`: cancel stale activation intent on explicit tab selection and expose the progress state on the root.
- `src/workbench/workbench.css`: apply the platform progress cursor during background table opening.
- `src/workbench/workbenchShell.test.js`: verify the UI wiring and CSS contract.

### Task 1: Safe Provisional State Cleanup And Persistence

**Files:**
- Modify: `src/workbench/workspaceState.test.js`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/utils/workspacePersistence.test.js`
- Modify: `src/workbench/utils/workspacePersistence.js`

- [ ] **Step 1: Write a failing non-focusing close test**

Add to `workspaceState.test.js`:

```js
test("closePaneTab can discard an inactive provisional tab without changing focus", () => {
  const state = createWorkspaceState();
  const pane1 = state.panes[state.focusedPaneId];
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const pane2 = state.panes["pane-2"];
  const current = openTableTab(state, { tableName: "current" }, { paneId: pane1.id, activate: true });
  const pending = openTableTab(state, { tableName: "pending" }, { paneId: pane2.id, activate: false });
  const originalFocusedPaneId = state.focusedPaneId;
  const originalActiveTabId = state.activeTabId;

  closePaneTab(state, pane2.id, pending.id, { focusOwner: false });

  assert.equal(state.focusedPaneId, originalFocusedPaneId);
  assert.equal(state.activeTabId, originalActiveTabId);
  assert.equal(state.tabs.some((tab) => tab.id === pending.id), false);
  assert.equal(state.tabs.some((tab) => tab.id === current.id), true);
});
```

- [ ] **Step 2: Run the state test and verify RED**

Run: `node --test src/workbench/workspaceState.test.js`

Expected: FAIL because `closePaneTab` ignores the `focusOwner` option and changes `focusedPaneId`.

- [ ] **Step 3: Implement the non-focusing close option**

Replace `closePaneTab` in `workspaceState.js` with:

```js
export function closePaneTab(state, paneId, tabId, { focusOwner = true } = {}) {
  if (!state || !tabId) return null;
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  if (isPinnedTab(state.tabs[index])) return null;
  const ownerPane = state.panes?.[paneId] || paneForTab(state, tabId);
  const [closed] = state.tabs.splice(index, 1);
  removeTabFromPane(state, ownerPane, tabId);
  if (ownerPane && focusOwner) {
    state.focusedPaneId = ownerPane.id;
    state.activeTabId = ownerPane.activeTabId || "";
  } else if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[index]?.id || state.tabs[index - 1]?.id || "";
  }
  return closed;
}
```

- [ ] **Step 4: Run the state test and verify GREEN**

Run: `node --test src/workbench/workspaceState.test.js`

Expected: PASS.

- [ ] **Step 5: Write a failing persistence test**

Add to `utils/workspacePersistence.test.js`:

```js
test("buildWorkspaceSnapshot excludes provisional opening tabs", () => {
  const snapshot = buildWorkspaceSnapshot({
    tabs: [
      { id: "tab-ready", kind: "data", tableName: "ready" },
      { id: "tab-opening", kind: "data", tableName: "opening", opening: true },
    ],
    activeTabId: "tab-ready",
    panes: {
      "pane-1": {
        id: "pane-1",
        tabIds: ["tab-ready", "tab-opening"],
        activeTabId: "tab-ready",
      },
    },
  });

  assert.deepEqual(snapshot.tabs.map((tab) => tab.id), ["tab-ready"]);
  assert.deepEqual(snapshot.panes["pane-1"].tabIds, ["tab-ready"]);
});
```

- [ ] **Step 6: Run the persistence test and verify RED**

Run: `node --test src/workbench/utils/workspacePersistence.test.js`

Expected: FAIL because `tab-opening` is still present in the snapshot.

- [ ] **Step 7: Filter provisional tabs before normalization**

Replace the `savedTabs` construction in `buildWorkspaceSnapshot`:

```js
const savedTabs = tabs
  .filter((tab) => !tab?.opening)
  .map((tab) => ({
    id: tab.id,
    kind: normalizeTabKind(tab.kind),
    connectionId: tab.connectionId || "",
    database: tab.database || "",
    tableName: tab.tableName || "",
    tableComment: tab.tableComment || "",
    filter: tab.filter || "",
    filterMode: tab.filterMode || "fuzzy",
    sort: tab.sort || null,
    frozenRowCount: Number(tab.frozenRowCount) || 0,
    frozenColumnCount: Number(tab.frozenColumnCount) || 0,
  }));
```

`normalizePanes` already derives valid IDs from `savedTabs`, so it removes the provisional pane reference without another state path.

- [ ] **Step 8: Run both focused test files**

Run: `node --test src/workbench/workspaceState.test.js src/workbench/utils/workspacePersistence.test.js`

Expected: PASS.

- [ ] **Step 9: Commit the state foundation**

```bash
git add src/workbench/workspaceState.js src/workbench/workspaceState.test.js src/workbench/utils/workspacePersistence.js src/workbench/utils/workspacePersistence.test.js
git commit -m "fix(workbench): isolate provisional table tabs"
```

### Task 2: Atomic Table Session Lifecycle

**Files:**
- Modify: `src/workbench/useTableSession.test.js`
- Modify: `src/workbench/composables/useTableSession.js`

- [ ] **Step 1: Write failing tests for pending, success, reuse, failure, and overlap**

First extend the workspace-state import in `useTableSession.test.js`:

```js
import { createWorkspaceState, openTableTab, appendTabPage } from "./workspaceState.js";
```

Then add focused tests using the existing `deferred()` helper. The core success test is:

```js
test("new table stays provisional until its first page is ready", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const page = deferred();
  const invoke = async (command) => {
    if (command === "open_table_session") return page.promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const opening = session.openTable({ tableName: "player" });
  const pending = workspace.tabs.find((tab) => tab.tableName === "player");
  assert.equal(pending.opening, true);
  assert.equal(workspace.activeTabId, current.id);
  assert.equal(session.pendingTableOpenCount.value, 1);

  page.resolve({
    sessionId: "player-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  const loaded = await opening;

  assert.equal(loaded.opening, false);
  assert.equal(workspace.activeTabId, loaded.id);
  assert.deepEqual(loaded.rows, [{ id: 1 }]);
  assert.equal(session.pendingTableOpenCount.value, 0);
});
```

Add these additional tests, using the existing `deferred()` helper:

```js
test("repeated opens reuse one provisional table request", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  openTableTab(workspace, { tableName: "current" }, { activate: true }).sessionId = "current-session";
  const page = deferred();
  let openCalls = 0;
  const invoke = async (command) => {
    if (command === "open_table_session") {
      openCalls += 1;
      return page.promise;
    }
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const first = session.openTable({ tableName: "player" });
  const second = session.openTable({ tableName: "player" });
  assert.equal(openCalls, 1);

  page.resolve({
    sessionId: "player-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  const [firstTab, secondTab] = await Promise.all([first, second]);

  assert.equal(firstTab, secondTab);
  assert.equal(workspace.tabs.filter((tab) => tab.tableName === "player").length, 1);
});

test("failed provisional open is removed without changing the current table", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const invoke = async (command) => {
    if (command === "open_table_session") throw new Error("offline");
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const loaded = await session.openTable({ tableName: "player" });

  assert.equal(loaded, null);
  assert.equal(workspace.activeTabId, current.id);
  assert.equal(workspace.tabs.some((tab) => tab.tableName === "player"), false);
  assert.equal(session.pendingTableOpenCount.value, 0);
});

test("overlapping opens retain progress until both finish", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const pages = new Map([["alpha", deferred()], ["beta", deferred()]]);
  const payload = (name) => ({
    sessionId: `${name}-session`,
    columns: [{ column_name: "id" }],
    rows: [{ id: name }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  const invoke = async (command, request) => {
    if (command === "open_table_session") return pages.get(request.tableName).promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const alpha = session.openTable({ tableName: "alpha" });
  const beta = session.openTable({ tableName: "beta" });
  assert.equal(session.pendingTableOpenCount.value, 2);

  pages.get("alpha").resolve(payload("alpha"));
  const alphaTab = await alpha;
  assert.equal(session.pendingTableOpenCount.value, 1);
  assert.equal(workspace.activeTabId, current.id);

  pages.get("beta").resolve(payload("beta"));
  const betaTab = await beta;
  assert.equal(session.pendingTableOpenCount.value, 0);
  assert.notEqual(alphaTab.id, betaTab.id);
  assert.equal(workspace.activeTabId, betaTab.id);
});

test("explicit tab selection cancels a pending table activation", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const page = deferred();
  const invoke = async (command) => {
    if (command === "open_table_session") return page.promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const opening = session.openTable({ tableName: "player" });
  session.cancelPendingTableActivation(workspace.focusedPaneId);
  page.resolve({
    sessionId: "player-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  await opening;

  assert.equal(workspace.activeTabId, current.id);
});
```

- [ ] **Step 2: Run the new session tests and verify RED**

Run: `node --test --test-name-pattern="provisional|overlapping opens|latest activation" src/workbench/useTableSession.test.js`

Expected: FAIL because `opening`, `pendingTableOpenCount`, request reuse, and guarded activation do not exist.

- [ ] **Step 3: Add opening state and request ownership**

Update imports and composable-local state:

```js
import { markRaw, ref, watch } from "vue";
import {
  activateTableTab,
  closePaneTab,
  openTableTab,
  replaceTabPage,
  appendTabPage,
  updateTabTotalMetadata,
  findTableDataTabs,
} from "../workspaceState.js";

const openingRequestsByTab = new Map();
const activationIntentByPane = new Map();
const pendingTableOpenCount = ref(0);
let activationIntentSequence = 0;
```

Add these helpers inside `useTableSession`:

```js
function claimActivationIntent(paneId, tabId) {
  const intent = { token: ++activationIntentSequence, tabId };
  activationIntentByPane.set(paneId, intent);
  return intent;
}

function cancelPendingTableActivation(paneId) {
  if (paneId) activationIntentByPane.delete(paneId);
}

function releaseActivationIntent(paneId, intent) {
  if (activationIntentByPane.get(paneId)?.token === intent?.token) {
    activationIntentByPane.delete(paneId);
  }
}

function activateForIntent(tab, paneId, intent) {
  if (!tab || activationIntentByPane.get(paneId)?.token !== intent?.token) return false;
  activateTableTab(workspace, tab.id);
  activationIntentByPane.delete(paneId);
  return true;
}

function discardProvisionalTab(tab, paneId) {
  if (!tab?.id || !findTabById(tab.id)) return;
  closePaneTab(workspace, paneId, tab.id, { focusOwner: false });
}
```

- [ ] **Step 4: Make the first-page loader data-only and reference-counted**

Remove the `activateWhenReady` parameter, delete `busy.value = true`, delete the activation call, and replace the existing `finally` block in `loadFirstPageIntoTab` with reference counting around the request:

```js
pendingTableOpenCount.value += 1;
try {
  tab.readOnly = readOnly;
  requestToken = beginTabRequest(tab.id);
  tab.loading = true;
  tab.loadingMore = false;
  tab.loadError = null;
  const page = await measureAsync(
    "table.open.invoke",
    () => invokeWorkbench("open_table_session", {
      connectionId,
      database,
      tableName,
      options: buildOpenSessionOptions(tab),
    }),
    { connectionId, database, tableName },
  );
  openedSessionId = String(page?.sessionId || "");
  if (!isCurrentTabRequest(tab.id, requestToken) || !findTabById(tab.id)) {
    await closeOwnedSession(openedSessionId);
    return null;
  }
  replaceTabPage(workspace, tab.id, page);
  openedSessionId = "";
  tab = findTabById(tab.id) || tab;
  tab.primaryKeys = page.primaryKeys || [];
  tab.tableComment = page.tableComment || "";
  tab.loadError = null;
  scheduleExactTotalRefresh(tab);
  ensureTableSchema(tableName, { connectionId, database }).catch(() => {});
  const msg = tableStatusLabel(tab, page.totalRows, page.totalRowsExact, page.hasMore);
  if (setStatus) setStatus(msg);
  else statusText.value = msg;
  return tab;
} finally {
  pendingTableOpenCount.value = Math.max(0, pendingTableOpenCount.value - 1);
}
```

Retain the existing performance marks and existing catch block around this body; only activation and shared busy ownership move out.

The current table remains interactive because a background open no longer sets the connection-wide busy flag.

- [ ] **Step 5: Add one reusable provisional open promise per tab**

Add:

```js
function startProvisionalOpen(tab, table, options, { paneId, intent } = {}) {
  tab.opening = true;
  const request = loadFirstPageIntoTab(tab, table, options)
    .then((loadedTab) => {
      if (!loadedTab) {
        releaseActivationIntent(paneId, intent);
        discardProvisionalTab(tab, paneId);
        return null;
      }
      loadedTab.opening = false;
      activateForIntent(loadedTab, paneId, intent);
      return loadedTab;
    })
    .finally(() => openingRequestsByTab.delete(tab.id));
  openingRequestsByTab.set(tab.id, request);
  return request;
}
```

At the start of `openTable`, after `targetPaneId`, add:

```js
const activationIntent = activate ? claimActivationIntent(targetPaneId, "") : null;
```

At the start of the existing-tab branch, add:

```js
if (existingTab.opening) {
  const loadedTab = await openingRequestsByTab.get(existingTab.id);
  if (activationIntent) {
    activationIntent.tabId = loadedTab?.id || existingTab.id;
    activateForIntent(loadedTab, targetPaneId, activationIntent);
  }
  return loadedTab;
}
```

Replace direct existing-tab activation with:

```js
if (activationIntent) {
  activationIntent.tabId = existingTab.id;
  activateForIntent(existingTab, targetPaneId, activationIntent);
}
```

Create every new tab with `{ activate: false, paneId: targetPaneId }`, set `activationIntent.tabId = tab.id` when present, then return:

```js
return startProvisionalOpen(tab, table, {
  connectionId,
  database,
  tableName,
  readOnly,
}, {
  paneId: targetPaneId,
  intent: activationIntent,
});
```

- [ ] **Step 6: Return the new public state and cancellation API**

Extend the return object:

```js
return {
  openTable,
  pendingTableOpenCount,
  cancelPendingTableActivation,
  fetchPage,
  loadNextPage,
  loadSearchResultPage,
  loadNextSearchResultPage,
  cancelSearchResultPage,
  toggleSort,
  applySort,
  dispose,
};
```

- [ ] **Step 7: Run session tests and verify GREEN**

Run: `node --test src/workbench/useTableSession.test.js`

Expected: PASS with no leaked-session or stale-request regressions.

- [ ] **Step 8: Commit the session lifecycle**

```bash
git add src/workbench/composables/useTableSession.js src/workbench/useTableSession.test.js
git commit -m "fix(workbench): publish loaded table tabs atomically"
```

### Task 3: Render And Pointer Feedback

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/WorkbenchSplitLayout.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Write a failing UI contract test**

Add to `workbenchShell.test.js`:

```js
test("provisional table opens stay hidden and expose nonblocking progress feedback", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  const styles = read("./workbench.css");

  assert.match(splitLayout, /props\.tabs\.filter\(\(tab\)\s*=>\s*ids\.has\(tab\.id\)\s*&&\s*!tab\.opening\)/);
  assert.match(orchestrator, /pendingTableOpenCount/);
  assert.match(orchestrator, /cancelPendingTableActivation\(paneId\)/);
  assert.match(orchestrator, /'is-opening-table':\s*pendingTableOpenCount\s*>\s*0/);
  assert.match(styles, /\.mysql-workbench\.is-opening-table[\s\S]*cursor:\s*progress/);
});
```

- [ ] **Step 2: Run the UI contract test and verify RED**

Run: `node --test --test-name-pattern="provisional table opens" src/workbench/workbenchShell.test.js`

Expected: FAIL because filtering, cancellation wiring, root state, and CSS are absent.

- [ ] **Step 3: Hide provisional tabs in the split layout**

Change `tabsForPane`:

```js
function tabsForPane(pane) {
  const ids = new Set(pane?.tabIds || []);
  return props.tabs.filter((tab) => ids.has(tab.id) && !tab.opening);
}
```

- [ ] **Step 4: Wire opening state and explicit-selection cancellation**

Destructure from `useTableSession`:

```js
const {
  openTable,
  pendingTableOpenCount,
  cancelPendingTableActivation,
  fetchPage,
  loadNextPage,
  loadSearchResultPage,
  loadNextSearchResultPage,
  cancelSearchResultPage,
  toggleSort,
  applySort,
  dispose: disposeTableSessions,
} = useTableSession(
  workspace,
  invokeWorkbench,
  {
    busy: conn.busy,
    statusText: conn.statusText,
    setStatus: conn.setStatus,
    ensureTableSchema: conn.ensureTableSchema,
  },
);
```

Before explicit tab activation in `activateTab`:

```js
if (paneId) cancelPendingTableActivation(paneId);
if (paneId) focusWorkspacePane(workspace, paneId);
activateTableTab(workspace, tabId);
```

Add the root class:

```vue
:class="{
  'is-dragging': paneIsDragging,
  'is-inspector-collapsed': inspectorCollapsed,
  'is-opening-table': pendingTableOpenCount > 0,
}"
```

- [ ] **Step 5: Add progress cursor styling**

Place next to the `.mysql-workbench` root rule:

```css
.mysql-workbench.is-opening-table,
.mysql-workbench.is-opening-table * {
  cursor: progress;
}
```

This intentionally overrides pointer and text cursors only while a table is preparing, but does not change pointer events or disable controls.

- [ ] **Step 6: Run the UI contract and focused regression tests**

Run: `node --test --test-name-pattern="provisional table opens" src/workbench/workbenchShell.test.js`

Expected: PASS.

Run: `node --test src/workbench/useTableSession.test.js src/workbench/workspaceState.test.js src/workbench/utils/workspacePersistence.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the UI feedback**

```bash
git add src/workbench/components/WorkbenchSplitLayout.vue src/workbench/MySqlWorkbench.vue src/workbench/workbench.css src/workbench/workbenchShell.test.js
git commit -m "fix(workbench): synchronize table tab presentation"
```

### Task 4: Final Verification

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run the table-open regression set**

Run:

```bash
node --test src/workbench/useTableSession.test.js src/workbench/useTableSearch.test.js src/workbench/useVirtualGrid.test.js src/workbench/workspaceState.test.js src/workbench/utils/workspacePersistence.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Run the build**

Run: `npm run build`

Expected: sidecar and Vite production build complete successfully.

- [ ] **Step 3: Start the browser development server**

Run: `npm run dev -- --host 127.0.0.1`

Expected: Vite prints a local URL, normally `http://127.0.0.1:1431/`.

- [ ] **Step 4: Verify delayed opening in the browser**

Use the mock backend with a temporary browser-only delay or network breakpoint and confirm:

1. Clicking a new table immediately changes the pointer to progress.
2. The current table remains visible and usable while waiting.
3. No new tab is visible before the first page resolves.
4. The new tab, selected state, columns, and rows appear together.
5. Selecting another existing tab while waiting prevents the slow request from stealing focus.
6. The progress cursor clears after the last overlapping open completes.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check HEAD~3..HEAD`

Expected: no whitespace errors. Confirm the unrelated `src-tauri/Cargo.toml` worktree change is absent from all feature commits.

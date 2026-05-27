# Refresh-Only Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all exposed browser context menus with one workbench-styled `刷新` action and remove the `设为 NULL` menu entry.

**Architecture:** Keep the existing `ContextMenu.vue` presentation and the source-aware refresh implementation in `useContextMenu.js`. Make the application shell intercept general right-clicks and have table-facing child panels forward their prevented right-click events with the current active table as the existing refresh target; sidebar table targets retain their explicit connection/database metadata.

**Tech Stack:** Vue 3 `<script setup>`, JavaScript ES modules, Node.js `node:test`, Vite.

---

## File Structure

- Modify `src/workbench/workbenchShell.test.js`: assert refresh-only rendering and event interception at the shell/component boundaries.
- Modify `src/workbench/useContextMenu.test.js`: retain database-source protection and prove the existing composable reloads a supplied active table while a general target reloads the tree.
- Modify `src/workbench/components/ContextMenu.vue`: remove the null-setting UI action and event declaration.
- Modify `src/workbench/components/WorkbenchSidebar.vue`: route all sidebar right-clicks, including search input right-clicks, through its custom-menu event without allowing native fallback.
- Modify `src/workbench/components/DataGrid.vue`: prevent/forward context-menu events from the active table surface.
- Modify `src/workbench/components/InspectorPanel.vue`: prevent/forward context-menu events from the table inspector and text editor surface.
- Modify `src/workbench/MySqlWorkbench.vue`: handle general and active-table context targets, wire panel events, and remove the null-setting menu binding.

No CSS change is planned: `.wb-context-menu` already renders the shared workbench visual language with `--wb-*` design tokens.

### Task 1: Lock Down Refresh Target Behavior

**Files:**
- Modify: `src/workbench/useContextMenu.test.js`

- [ ] **Step 1: Add behavioral tests for active-table and general refresh targets**

Append these tests to `src/workbench/useContextMenu.test.js`:

```js
test("refreshing a supplied active table reloads its current page", async () => {
  const schemaCalls = [];
  const fetchCalls = [];
  const activeTab = {
    value: {
      tableName: "hero",
      tableKey: "mysql-1\u001fdev_game\u001fhero",
      connectionId: "mysql-1",
      database: "dev_game",
      page: 3,
    },
  };
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async (...args) => schemaCalls.push(args),
      fetchPage: async (...args) => fetchCalls.push(args),
    },
    activeTab,
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 }, activeTab.value);
  await menu.refreshFromContextMenu();

  assert.deepEqual(schemaCalls, [["hero", { connectionId: "mysql-1", database: "dev_game" }]]);
  assert.deepEqual(fetchCalls, [[activeTab.value, 3]]);
});

test("refreshing a general context reloads the object tree", async () => {
  const loadCalls = [];
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => loadCalls.push("load"),
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 });
  await menu.refreshFromContextMenu();

  assert.deepEqual(loadCalls, ["load"]);
});
```

- [ ] **Step 2: Run the focused composable test**

Run: `node --test src/workbench/useContextMenu.test.js`

Expected: PASS, because the existing source-aware composable already provides the required current-table and object-tree refresh behavior. This confirms no new backend or composable behavior is needed before the event-wiring RED cycle.

### Task 2: Replace Native Menus And Remove Null Action

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/ContextMenu.vue`
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/InspectorPanel.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`

- [ ] **Step 1: Replace the shell assertion with a failing refresh-only context-menu contract**

Replace the test named `sidebar preserves text input context menus and forwards table context payloads safely` in `src/workbench/workbenchShell.test.js` with:

```js
test("workbench suppresses native context menus and exposes only refresh", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const grid = read("./components/DataGrid.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(orchestrator, /@contextmenu\.prevent="openGeneralContextMenu"/);
  assert.match(orchestrator, /function\s+openGeneralContextMenu/);
  assert.match(orchestrator, /function\s+openActiveTableContextMenu/);
  assert.match(orchestrator, /@contextmenu="openActiveTableContextMenu"/);
  assert.doesNotMatch(orchestrator, /@set-null|setCellToNull/);
  assert.match(sidebar, /@contextmenu\.prevent\.stop="emit\('contextmenu', \$event\)"/);
  assert.doesNotMatch(sidebar, /@contextmenu\.stop(?:\s|=)/);
  assert.match(grid, /@contextmenu\.prevent\.stop="emit\('contextmenu', \$event\)"/);
  assert.match(inspector, /@contextmenu\.prevent\.stop="emit\(["']contextmenu["'], \$event\)"/);
  assert.match(menu, />刷新</);
  assert.doesNotMatch(menu, /设为 NULL|set-null/);
});
```

- [ ] **Step 2: Run the shell test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the main container does not yet intercept context menus, the table-facing panels do not yet forward prevented events, and `ContextMenu.vue` still contains `设为 NULL`.

- [ ] **Step 3: Render only refresh in the custom menu**

Update `src/workbench/components/ContextMenu.vue` so its emitted action and template buttons are:

```vue
const emit = defineEmits(['refresh']);
```

```vue
<menu v-if="open" class="wb-context-menu" :style="contextMenuStyle" @click.stop>
  <button type="button" @click="emit('refresh')">刷新</button>
</menu>
```

- [ ] **Step 4: Prevent native menu fallback throughout child surfaces**

Update the sidebar root in `src/workbench/components/WorkbenchSidebar.vue`, and remove the search input's existing `@contextmenu.stop` attribute:

```vue
<aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent.stop="emit('contextmenu', $event)">
```

Extend the `defineEmits` list in `src/workbench/components/DataGrid.vue` with `'contextmenu'`, then update its root:

```vue
<section v-if="tab" class="wb-table-panel" @contextmenu.prevent.stop="emit('contextmenu', $event)">
```

Extend `src/workbench/components/InspectorPanel.vue` emission contract and root element:

```vue
const emit = defineEmits(["update:textDraft", "save-text-panel", "contextmenu"]);
```

```vue
<aside class="wb-inspector wb-info-pane" @contextmenu.prevent.stop="emit('contextmenu', $event)">
```

- [ ] **Step 5: Wire shell refresh targets and remove the null menu entry**

In `src/workbench/MySqlWorkbench.vue`, stop destructuring `setCellToNull` from the editor, add the two handlers beside `openSidebarContextMenu`, and update the root and panel wiring:

```js
function openGeneralContextMenu(event) {
  openContextMenu(event);
}

function openActiveTableContextMenu(event) {
  openContextMenu(event, activeTab.value);
}
```

```vue
<main
  class="mysql-workbench"
  @click="closeContextMenu"
  @keydown="handleUndoKeydown"
  @contextmenu.prevent="openGeneralContextMenu"
>
```

```vue
<DataGrid
  ...
  @contextmenu="openActiveTableContextMenu"
/>

<InspectorPanel
  ...
  @contextmenu="openActiveTableContextMenu"
/>
```

```vue
<ContextMenu
  :open="contextMenu.open"
  :x="contextMenu.x"
  :y="contextMenu.y"
  @refresh="refreshFromContextMenu"
/>
```

- [ ] **Step 6: Run the focused tests to verify GREEN**

Run: `node --test src/workbench/workbenchShell.test.js src/workbench/useContextMenu.test.js`

Expected: PASS with no failures.

### Task 3: Full Frontend And Interaction Verification

**Files:**
- Verify: `src/workbench/*.test.js`
- Verify: frontend Vite output and browser-mode UI

- [ ] **Step 1: Run all JavaScript unit and contract tests**

Run: `node --test src/workbench/*.test.js`

Expected: PASS with zero test failures.

- [ ] **Step 2: Build the frontend**

Run: `npm run build`

Expected: Vite exits successfully and writes the frontend build to `dist/`.

- [ ] **Step 3: Check the browser-mode interaction**

Run: `npm run dev -- --host 127.0.0.1`

Open `http://127.0.0.1:1431/` with the in-app Browser tool and verify:

```text
1. Right-click the left navigation background: only the styled “刷新” menu appears.
2. Right-click a table node: only “刷新” appears and selecting it reports a table refresh.
3. Open a table and right-click the data grid and right inspector: only “刷新” appears and selecting it reloads the visible table page.
4. Right-click a search/text input: the native save/print/inspect menu does not appear; only “刷新” is present.
```

Stop the Vite process after interaction verification.

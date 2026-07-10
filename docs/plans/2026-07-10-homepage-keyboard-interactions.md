# Homepage Keyboard Interactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix homepage table-object clipboard shortcuts, F2 blur-save rename, and context-aware Ctrl/Cmd+F without changing data-table behavior.

**Architecture:** Keep the current homepage controller and backend commands, but expose homepage UI commands through the focused pane and route global shortcuts by the focused tab kind. Remount the homepage component on database identity changes, and keep rename focus/submission guards local to the list component.

**Tech Stack:** Vue 3 Composition API, Node.js `node:test`, Vite 6, Playwright CLI.

---

### Task 1: Make F2 Rename Focus And Save Reliably

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/DatabaseTableList.vue`
- Modify: `src/workbench/components/DatabaseHome.vue`

**Step 1: Write the failing regression assertions**

Extend the database-homepage shell test to require a callback ref, blur
submission, and guarded Escape cancellation:

```js
assert.match(tableList, /:ref="setRenameInput"/);
assert.match(tableList, /@blur="submitRename"/);
assert.match(tableList, /function\s+cancelRename/);
assert.match(tableList, /renameSubmissionHandled/);
assert.match(home, /result\.reason\s*===\s*["']unchanged["']/);
```

**Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern "database homepage" src/workbench/workbenchShell.test.js
```

Expected: FAIL because the current input uses a `v-for` string ref, has no
blur handler, and treats an unchanged value as an error.

**Step 3: Implement the minimal rename behavior**

In `DatabaseTableList.vue`:

```js
const renameInputRef = ref(null);
const renameSubmissionHandled = ref(false);

function setRenameInput(element) {
  renameInputRef.value = element || null;
}

function submitRename() {
  if (renameSubmissionHandled.value) return;
  renameSubmissionHandled.value = true;
  emit("submit-rename", props.renamingName, props.renameDraft);
}

function cancelRename() {
  renameSubmissionHandled.value = true;
  emit("cancel-rename");
}
```

Reset the guard when a new rename starts and when the draft changes. Bind the
input with `:ref="setRenameInput"`, `@blur="submitRename"`, and the guarded
Escape handler. In `DatabaseHome.vue`, handle the `unchanged` validation reason
by clearing status and cancelling the editor without emitting a backend call.

**Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: PASS.

**Step 5: Commit the task**

```powershell
git add src/workbench/workbenchShell.test.js src/workbench/components/DatabaseTableList.vue src/workbench/components/DatabaseHome.vue
git commit -m "fix(workbench): save homepage rename on blur"
```

### Task 2: Route Homepage Copy And Paste From Any Non-Editable Focus

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/DatabaseHome.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`

**Step 1: Write the failing regression assertions**

Require the homepage component to expose copy/paste commands, the pane to
publish them, the global handler to route Ctrl/Cmd+C and Ctrl/Cmd+V only for a
focused homepage, and the homepage component key to use `tabKey`:

```js
assert.match(home, /defineExpose\(\{[^}]*copySelection[^}]*pasteTables/s);
assert.match(pane, /copyHomeSelection/);
assert.match(pane, /pasteHomeTables/);
assert.match(pane, /:key="activeHomeTab\.tabKey\s*\|\|\s*activeHomeTab\.id"/);
assert.match(orchestrator, /function\s+handleGlobalHomeClipboardKeydown/);
assert.match(orchestrator, /isEditableShortcutTarget\(event\.target\)/);
assert.match(orchestrator, /focusedPaneState\.copyHomeSelection/);
assert.match(orchestrator, /focusedPaneState\.pasteHomeTables/);
```

**Step 2: Run the focused test and verify RED**

Run the database-homepage shell test pattern. Expected: FAIL because homepage
clipboard shortcuts currently depend on list focus and the component is keyed
only by its reused id.

**Step 3: Implement focused-pane command routing**

- Make `DatabaseHome.copySelection()` and `pasteTables()` return a Boolean
  indicating whether an action was emitted, then expose both methods.
- Add a `DatabaseHome` template ref in `WorkbenchPane` and publish wrapper
  methods in `emitPaneState()`.
- Change the homepage key to `activeHomeTab.tabKey || activeHomeTab.id`.
- Add `handleGlobalHomeClipboardKeydown(event)` to `MySqlWorkbench.vue`. It
  must require a focused home tab, reject editable targets, match only
  Ctrl/Cmd+C or Ctrl/Cmd+V, and prevent/stop the event only after the pane
  command reports it handled.
- Call this handler from the existing document capture shortcut handler before
  the Ctrl/Cmd+F and Ctrl/Cmd+P routes.

**Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern "database homepage|openDatabaseHomeTab" src/workbench/workbenchShell.test.js src/workbench/workspaceState.test.js
```

Expected: PASS.

**Step 5: Commit the task**

```powershell
git add src/workbench/workbenchShell.test.js src/workbench/components/DatabaseHome.vue src/workbench/components/WorkbenchPane.vue src/workbench/MySqlWorkbench.vue
git commit -m "fix(workbench): route homepage clipboard shortcuts"
```

### Task 3: Route Ctrl/Cmd+F To The Current Page Search

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/DatabaseHome.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`

**Step 1: Write the failing regression assertions**

Extend the global Ctrl+F test to require the homepage input ref, exposed focus
method, a pane-level unified command, and document routing through that command:

```js
assert.match(home, /ref="searchInputRef"/);
assert.match(home, /function\s+focusSearch/);
assert.match(home, /defineExpose\(\{[^}]*focusSearch/s);
assert.match(pane, /function\s+focusCurrentSearch/);
assert.match(orchestrator, /focusedPaneState\.focusCurrentSearch/);
```

Keep the existing assertions that the data-table search uses the same shortcut
binding and that the document capture listener prevents native WebView find.

**Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern "Ctrl\+F is captured globally" src/workbench/workbenchShell.test.js
```

Expected: FAIL because only the data-table search is exposed today.

**Step 3: Implement unified current-search focus**

- Add `searchInputRef` and `focusSearch()` to `DatabaseHome.vue`; focus and
  select the field.
- In `WorkbenchPane.vue`, add `focusCurrentSearch()` that calls the homepage ref
  for an active home tab and existing `focusTableSearch()` for an active data
  tab. Publish it in pane state.
- Replace the orchestrator's data-only focus call with
  `focusedPaneState.focusCurrentSearch?.()` and return whether a current page
  accepted the command.

**Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: PASS, with the existing table-search
assertions still passing.

**Step 5: Commit the task**

```powershell
git add src/workbench/workbenchShell.test.js src/workbench/components/DatabaseHome.vue src/workbench/components/WorkbenchPane.vue src/workbench/MySqlWorkbench.vue
git commit -m "fix(workbench): focus homepage search with Ctrl+F"
```

### Task 4: Verify The Complete User Flows

**Files:**
- No production files expected.

**Step 1: Run focused automated regression tests**

```powershell
node --test src/workbench/useDatabaseHome.test.js src/workbench/workspaceState.test.js
node --test --test-name-pattern "database homepage|Ctrl\+F is captured globally" src/workbench/workbenchShell.test.js
```

Expected: all selected tests PASS.

**Step 2: Run broad frontend verification**

```powershell
node --test "src/workbench/**/*.test.js"
npm run build
```

Expected: build PASS. Compare any broad-suite failures with the recorded clean
baseline; no new failures are allowed.

**Step 3: Verify in a real browser**

Use the browser demo and Playwright CLI to prove:

1. Right-click a table, choose Copy, then press Ctrl+V without manually
   refocusing the list; exactly one copied table appears.
2. Copy in one database, switch to another database, and press Ctrl+V; the
   request uses the current source and target databases.
3. Select a table and press F2; the rename input is focused and fully selected.
4. Type a valid new name and click the homepage search input; exactly one
   rename occurs. Escape performs no rename.
5. Ctrl+F on the homepage focuses/selects the homepage search. Ctrl+F on a data
   table still focuses the table search.
6. Ctrl+C/V inside the homepage search and rename inputs remain native text
   clipboard operations.

**Step 4: Review the final diff**

Confirm only the planned docs, components, orchestrator, and regression test
changed. Run `git status --short` and `git diff --check` before completion.

# Homepage Delete And Refresh Bugfix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make confirmed homepage table deletion reach the desktop backend and prevent a second Refresh menu from appearing after the homepage menu closes.

**Architecture:** Keep the existing delete and context-menu flows intact. Correct the frontend request boundary to match the Rust Tauri command contract, and stop the homepage blank-area context-menu event before it reaches the workbench-wide handler.

**Tech Stack:** Vue 3 templates and Composition API, Tauri 2 command invocation, Node.js `node:test` regression tests.

---

### Task 1: Add regression coverage

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Write the failing delete-payload assertion**

Extend the homepage object-operation test so it requires the desktop command payload to contain a nested request object:

```js
assert.match(
  orchestrator,
  /invokeWorkbench\(["']drop_tables["'],\s*\{\s*request:\s*\{[\s\S]*?connectionId:\s*source\.connectionId,[\s\S]*?database:\s*source\.database,[\s\S]*?tables:\s*tableNames,[\s\S]*?\}\s*,?\s*\}\s*\)/,
);
```

**Step 2: Write the failing context-menu propagation assertion**

Add a focused test that checks the list background handler uses both Vue event modifiers:

```js
test("homepage blank-area context menu does not bubble to the workbench menu", () => {
  const tableList = read("./components/DatabaseTableList.vue");
  assert.match(tableList, /@contextmenu\.prevent\.stop="emit\('blank-contextmenu', \$event\)"/);
});
```

**Step 3: Run the focused test and verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: the new nested-request assertion and `.prevent.stop` assertion fail against the current production code, while the existing assertions remain unchanged.

### Task 2: Correct both frontend boundaries

**Files:**
- Modify: `src/workbench/MySqlWorkbench.vue:2102`
- Modify: `src/workbench/components/DatabaseTableList.vue:363`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Wrap the desktop delete command arguments**

Replace the flattened payload with the Rust-compatible request shape:

```js
await invokeWorkbench("drop_tables", {
  request: {
    connectionId: source.connectionId,
    database: source.database,
    tables: tableNames,
  },
});
```

**Step 2: Stop blank-area context-menu propagation**

Update the root list handler:

```vue
@contextmenu.prevent.stop="emit('blank-contextmenu', $event)"
```

**Step 3: Run the focused test and verify GREEN**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: all tests pass.

### Task 3: Verify the homepage regression scope

**Files:**
- Verify: `src/workbench/workbenchShell.test.js`
- Verify: `src/workbench/useDatabaseHome.test.js`
- Verify: `src/workbench/`

**Step 1: Run homepage controller tests**

Run: `node --test src/workbench/useDatabaseHome.test.js`

Expected: all tests pass.

**Step 2: Run the complete frontend test baseline**

Run: `node --test src/workbench`

Expected: all tests pass. If unrelated pre-existing dirty tests fail, compare failures with the pre-fix baseline and report them without changing unrelated files.

**Step 3: Build the frontend and sidecar bundle**

Run: `npm run build`

Expected: exit code 0 and Vite produces `dist/` successfully.

**Step 4: Inspect the final diff**

Run: `git diff -- src/workbench/MySqlWorkbench.vue src/workbench/components/DatabaseTableList.vue src/workbench/workbenchShell.test.js docs/plans/2026-07-10-homepage-delete-refresh-bugfix.md`

Expected: only the two boundary fixes, two regression assertions, and this implementation plan appear.

### Task 4: Commit the bug fix only

**Files:**
- Add: `docs/plans/2026-07-10-homepage-delete-refresh-bugfix.md`
- Add: `src/workbench/MySqlWorkbench.vue`
- Add: `src/workbench/components/DatabaseTableList.vue`
- Add: `src/workbench/workbenchShell.test.js`

**Step 1: Stage only this task's files**

```bash
git add docs/plans/2026-07-10-homepage-delete-refresh-bugfix.md src/workbench/MySqlWorkbench.vue src/workbench/components/DatabaseTableList.vue src/workbench/workbenchShell.test.js
```

**Step 2: Verify the staged scope**

Run: `git diff --cached --name-status`

Expected: exactly the four files listed above.

**Step 3: Commit**

```bash
git commit -m "fix: repair homepage table deletion and refresh menu"
```

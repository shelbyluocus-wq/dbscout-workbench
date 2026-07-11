# Table Search Behavior Restoration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore automatic complete in-table search without replacing or flashing the ordinary data grid.

**Architecture:** Route normal table search back through the existing local incremental matcher and ordinary page loader. Keep backend hit-result jobs isolated to explicit hit-result workflows and preserve cancellation with the current search run token.

**Tech Stack:** Vue 3 composables, Node.js `node:test`, Tauri command bridge.

---

### Task 1: Lock the expected interaction contract

**Files:**
- Modify: `src/workbench/useTableSearch.test.js`
- Modify: `src/workbench/useTableSession.test.js`

**Step 1:** Add tests proving a normal query keeps ordinary rows and never invokes the hit-result loader.

**Step 2:** Add tests proving remaining ordinary pages load automatically until the hit count is complete.

**Step 3:** Add tests proving rapid typing cancels stale scans and clearing does not refetch or replace the table.

**Step 4:** Run `node --test src/workbench/useTableSearch.test.js src/workbench/useTableSession.test.js` and confirm the new assertions fail for the current hit-only behavior.

### Task 2: Restore normal table search

**Files:**
- Modify: `src/workbench/composables/useTableSearch.js`
- Modify only if required: `src/workbench/composables/useTableSession.js`
- Modify only if required: `src/workbench/MySqlWorkbench.vue`

**Step 1:** Route normal search through `findSearchMatches()` and the ordinary `loadNextPage()` function.

**Step 2:** Automatically continue until `tab.fullyLoaded`, guarded by the current run token and active tab.

**Step 3:** Keep the grid row store and main loading state untouched while search is running.

**Step 4:** Keep explicit hit-result workflows isolated from normal search input.

**Step 5:** Re-run the focused tests and confirm they pass.

### Task 3: Verify the product path

**Files:**
- Modify only if a regression is found: focused source or test files.

**Step 1:** Run `node scripts/test-workbench.mjs`.

**Step 2:** Run `node scripts/test-sidecar.mjs`.

**Step 3:** Run `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo check --manifest-path src-tauri/Cargo.toml`.

**Step 4:** Run `npm run build` and `git diff --check`.

**Step 5:** Validate in the running UI that the table stays visible, the count finishes without `+`, and next/previous only navigate.

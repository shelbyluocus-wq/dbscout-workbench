# Value Search Contiguous Match Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make value search return only cells that contain the complete query as one continuous, case-insensitive substring.

**Architecture:** Keep the existing `search_values` command contract and change only its match policy in the MySQL pattern builder, demo search, and browser mock. Add a contains-only mode to the shared search matcher so value previews highlight the same range the backend accepted, without changing fuzzy schema search.

**Tech Stack:** Rust, sqlx/MySQL, Vue 3, JavaScript, Node test runner, Cargo test runner.

---

### Task 1: Lock the backend match contract

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/demo.rs`

**Step 1: Write the failing tests**

Change the MySQL pattern expectation for `hrp` to only `"%hrp%"`. Change demo value-search tests so `HeroProp` does not match `hrp`, while a mixed-case contiguous substring still matches.

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test value_search_patterns --lib && cargo test search_demo_values --lib`

Expected: existing subsequence behavior causes the new assertions to fail.

**Step 3: Implement the minimal behavior**

Return only the escaped contains pattern from `value_search_patterns`. Remove the subsequence fallback loops from value-search-only demo functions; do not change demo table filtering.

**Step 4: Run focused Rust tests**

Run: `cd src-tauri && cargo test value_search_patterns --lib && cargo test search_demo_values --lib`

Expected: PASS.

### Task 2: Align browser mock value search

**Files:**
- Modify: `src/workbench/mockBackend.test.js`
- Modify: `src/workbench/mock/mockBackend.js`

**Step 1: Write the failing test**

Replace the subsequence fixture assertion with a regression proving that `21020` does not match a value containing only separated `2`, `10`, and `20` fragments, but does match a value containing contiguous `21020`.

**Step 2: Run test to verify it fails**

Run: `node --test src/workbench/mockBackend.test.js`

Expected: the separated fixture is returned by the current fuzzy matcher.

**Step 3: Implement the minimal behavior**

Use a case-insensitive contiguous-substring predicate only in the `search_values` branch. Keep the existing fuzzy predicate for normal table filtering.

**Step 4: Run the focused test**

Run: `node --test src/workbench/mockBackend.test.js`

Expected: PASS.

### Task 3: Align value-result highlighting

**Files:**
- Modify: `src/workbench/utils/searchMatch.js`
- Modify: `src/workbench/searchMatch.test.js`
- Modify: `src/workbench/components/SidebarSearchPanel.vue`
- Modify: `src/workbench/components/QuickOpenPalette.vue`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Write failing matcher and wiring tests**

Add a `contains` matcher-mode test showing `abc21020xyz` matches and `2...10...20` does not. Assert both value-result components use the contains-only highlighter for `previewValue`.

**Step 2: Run tests to verify they fail**

Run: `node --test src/workbench/searchMatch.test.js src/workbench/workbenchShell.test.js`

Expected: the matcher falls through to fuzzy matching and value previews use the generic highlighter.

**Step 3: Implement the minimal behavior**

Add contains-only handling after exact/prefix/contains classification and pass `{ mode: "contains" }` only when highlighting value-result previews.

**Step 4: Run focused frontend tests**

Run: `node --test src/workbench/searchMatch.test.js src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 4: Verify the complete change

**Files:**
- Verify all modified files.

**Step 1: Run frontend and sidecar tests**

Run: `node --test src/workbench && node --test sidecar`

Expected: PASS with zero failures.

**Step 2: Run Rust tests**

Run: `cd src-tauri && cargo test`

Expected: PASS with zero failures.

**Step 3: Build the frontend**

Run: `npm run build`

Expected: exit code 0.

**Step 4: Inspect the final diff**

Confirm the change affects value search only and preserves the user's unrelated batch-import worktree changes.

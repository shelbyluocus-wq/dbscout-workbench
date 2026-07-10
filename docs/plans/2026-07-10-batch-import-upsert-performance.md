# Batch Import Upsert, Performance, and Cancellation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make batch import update existing primary keys, process rows in bounded batches, and support user cancellation without losing completed work.

**Architecture:** Add a bounded `import_rows` Tauri command backed by a focused Rust module that reads schema once per batch and performs audited insert-or-update operations. Change the Vue composable to send 100-row chunks, aggregate row outcomes, and stop scheduling chunks when cancellation is requested.

**Tech Stack:** Vue 3 Composition API, Node `node:test`, Tauri 2, Rust, SQLx MySQL/SQLite audit storage, SheetJS XLSX.

---

### Task 1: Define Batch Import Contract

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src/workbench/mockBackend.test.js`

**Step 1:** Add a failing mock contract test for `import_rows` with inserted, updated, unchanged, and row error results.

**Step 2:** Run `node --test src/workbench/mockBackend.test.js` and confirm the command is missing.

**Step 3:** Add camelCase request/response structs, command registration, and mock behavior with a maximum of 100 rows.

**Step 4:** Rerun the test and confirm it passes.

### Task 2: Implement Audited Backend Upsert

**Files:**
- Create: `src-tauri/src/batch_import.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/batch_import.rs`

**Step 1:** Write failing Rust tests for SQL planning: insert with inverse delete, update mapped fields with inverse old values, unchanged row, composite keys, and batch-size rejection.

**Step 2:** Run `cargo test batch_import::tests --lib` and confirm the new behavior is missing.

**Step 3:** Implement schema-once row processing, primary-key lookup, insert/update planning, execution, per-row error collection, and audit finalization.

**Step 4:** Rerun `cargo test batch_import::tests --lib` and existing validation/audit tests.

### Task 3: Chunked Frontend Import

**Files:**
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/useBatchTransfer.test.js`

**Step 1:** Write failing tests proving 250 rows produce three `import_rows` calls, duplicate keys are reported as updates rather than failures, and result counters aggregate correctly.

**Step 2:** Run `node --test src/workbench/useBatchTransfer.test.js` and confirm it still calls `insert_row` per row.

**Step 3:** Replace per-row invokes with 100-row chunk calls and map backend error indexes to Excel row numbers and source metadata.

**Step 4:** Rerun the focused test.

### Task 4: Cancellation State and UI

**Files:**
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/components/BatchImportDialog.vue`
- Modify: `src/workbench/useBatchTransfer.test.js`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1:** Write failing tests proving cancellation stops the next chunk and the dialog exposes “取消导入” / “正在取消…”.

**Step 2:** Run the focused Node tests and confirm failure.

**Step 3:** Add `cancelRequested`, `cancelBatchImport()`, cancelled result/status handling, and the import-time cancel button.

**Step 4:** Rerun focused tests.

### Task 5: End-to-End Verification

**Files:**
- Verify: `src/workbench/useBatchTransfer.test.js`
- Verify: `src/workbench/mockBackend.test.js`
- Verify: `src/workbench/workbenchShell.test.js`
- Verify: `src-tauri/src/batch_import.rs`
- Verify: `src-tauri/src/validation.rs`

**Step 1:** Run focused Node and Rust tests.

**Step 2:** Run `npm run build`.

**Step 3:** Inspect `git diff --check` and the final file scope.

**Step 4:** Validate the dialog in a real browser and confirm no control overlap.

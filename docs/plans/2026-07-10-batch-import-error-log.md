# Batch Import Error Log Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users export all batch-import failures as a structured XLSX workbook.

**Architecture:** Build the workbook and save it inside `useBatchTransfer`, reusing the existing lazy XLSX loader, cell clamping, and `save_export_file` command. Keep `BatchImportDialog` presentation-only by calling the composable action directly.

**Tech Stack:** Vue 3 Composition API, SheetJS XLSX, Node `node:test`, Tauri command bridge.

---

### Task 1: Error Workbook Export

**Files:**
- Modify: `src/workbench/useBatchTransfer.test.js`
- Modify: `src/workbench/composables/useBatchTransfer.js`

**Step 1: Write the failing test**

Add a test that seeds `batchImport.progress.errors`, calls `exportBatchImportErrors()`, reads the saved XLSX payload, and asserts the seven Chinese headers and normalized error row.

**Step 2: Run test to verify it fails**

Run: `node --test src/workbench/useBatchTransfer.test.js`

Expected: FAIL because `exportBatchImportErrors` does not exist.

**Step 3: Write minimal implementation**

Add an error-to-row formatter, workbook creation, timestamped filename, `save_export_file` invocation, and status/error handling. Return `null` when there are no errors.

**Step 4: Run test to verify it passes**

Run: `node --test src/workbench/useBatchTransfer.test.js`

Expected: PASS.

### Task 2: Dialog Action

**Files:**
- Modify: `src/workbench/components/BatchImportDialog.vue`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write the failing test**

Assert the dialog renders “导出错误日志” only from the error-state block and calls `transfer.exportBatchImportErrors()`.

**Step 2: Run test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the action is absent.

**Step 3: Write minimal implementation**

Add a secondary footer button guarded by `batch.progress.errors.length`, disabled while busy, and wired to the composable action.

**Step 4: Run test to verify it passes**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 3: Regression Verification

**Files:**
- Verify: `src/workbench/useBatchTransfer.test.js`
- Verify: `src/workbench/useImportWizard.test.js`
- Verify: `src/workbench/valueValidation.test.js`
- Verify: `src-tauri/src/validation.rs`

**Step 1: Run focused frontend tests**

Run: `node --test src/workbench/useBatchTransfer.test.js src/workbench/useImportWizard.test.js src/workbench/valueValidation.test.js src/workbench/workbenchShell.test.js`

Expected: PASS.

**Step 2: Run Rust validation tests**

Run: `cargo test validation::tests --lib` from `src-tauri`.

Expected: PASS.

**Step 3: Run the frontend build**

Run: `npm run build`

Expected: PASS.

**Step 4: Inspect scope**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; unrelated version files remain untouched.

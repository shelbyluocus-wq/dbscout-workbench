# Sidebar Table Name Priority Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let table names use available sidebar width before inline comments while preserving side-by-side comment scanning.

**Architecture:** Keep the table-row markup and metadata unchanged. Move single-line truncation from separately competing flex children to the combined copy line, so content order enforces the priority: name first, comment only in remaining visible room.

**Tech Stack:** Vue 3, CSS, Node.js test runner, Vite.

---

### Task 1: Capture The Table-Name Priority Contract

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write the failing assertions**

Require `.wb-table-copy` to own single-line ellipsis behavior, require comment spacing without a separate flex allocation, and reject a `.wb-table-copy.has-comment .wb-table-name` percentage cap.

**Step 2: Run the focused test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because commented names are currently capped by `max-width: 48%`.

### Task 2: Apply Combined-Line Truncation

**Files:**
- Modify: `src/workbench/workbench.css`

**Step 1: Implement the minimal layout change**

Make `.wb-table-copy` a one-line overflowing text container, remove child flex sizing and the `48%` name cap, and apply horizontal separation to the inline `.wb-table-comment`.

**Step 2: Run the focused test to verify it passes**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 3: Verify Resizable Sidebar Behavior

**Files:**
- No additional code changes expected.

**Step 1: Run frontend tests**

Run: `node --test src/workbench`

Expected: All tests pass.

**Step 2: Run frontend build**

Run: `npm run build`

Expected: Vite build exits with code 0.

**Step 3: Inspect sidebar resizing in the browser**

Open the local app with table comments visible. Confirm widening exposes more comments across the table list, and narrowing truncates comments before any table name that fits.

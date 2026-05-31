# Sidebar Drag Reorder Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live placeholder-style reorder preview and smooth movement animation for MySQL connection and database nodes in the workbench sidebar.

**Architecture:** Extract pure drag-preview ordering logic into a small sidebar helper module, then have `WorkbenchSidebar.vue` render computed preview lists while dragging. Use Vue `TransitionGroup` and token-driven CSS transitions for FLIP-style row movement, with reduced-motion fallback.

**Tech Stack:** Vue 3 `<script setup>`, Node.js `node:test`, CSS custom properties, native HTML drag/drop.

---

### Task 1: Preview Ordering Helper

**Files:**
- Create: `src/workbench/sidebarDragPreview.js`
- Create: `src/workbench/sidebarDragPreview.test.js`

- [ ] **Step 1: Write the failing helper tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { previewDragOrder, sameDragTarget } from "./sidebarDragPreview.js";

const connections = [{ id: "demo" }, { id: "mysql-1" }, { id: "mysql-2" }];
const connectionId = (connection) => connection.id;

test("previewDragOrder moves an item before the target", () => {
  assert.deepEqual(
    previewDragOrder(connections, "mysql-2", "demo", { position: "before", getKey: connectionId }).map(connectionId),
    ["mysql-2", "demo", "mysql-1"],
  );
});

test("previewDragOrder moves an item after the target", () => {
  assert.deepEqual(
    previewDragOrder(connections, "demo", "mysql-1", { position: "after", getKey: connectionId }).map(connectionId),
    ["mysql-1", "demo", "mysql-2"],
  );
});

test("previewDragOrder leaves order unchanged when target is the source", () => {
  assert.deepEqual(
    previewDragOrder(connections, "mysql-1", "mysql-1", { position: "after", getKey: connectionId }).map(connectionId),
    ["demo", "mysql-1", "mysql-2"],
  );
});

test("previewDragOrder leaves order unchanged when source or target is missing", () => {
  assert.deepEqual(
    previewDragOrder(connections, "missing", "demo", { position: "before", getKey: connectionId }).map(connectionId),
    ["demo", "mysql-1", "mysql-2"],
  );
  assert.deepEqual(
    previewDragOrder(connections, "demo", "missing", { position: "before", getKey: connectionId }).map(connectionId),
    ["demo", "mysql-1", "mysql-2"],
  );
});

test("sameDragTarget compares kind, id, and position", () => {
  assert.equal(sameDragTarget({ kind: "database", id: "game", position: "before" }, "database", "game", "before"), true);
  assert.equal(sameDragTarget({ kind: "database", id: "game", position: "after" }, "database", "game", "before"), false);
  assert.equal(sameDragTarget({ kind: "connection", id: "game", position: "before" }, "database", "game", "before"), false);
});
```

- [ ] **Step 2: Run helper tests to verify RED**

Run: `node --test src/workbench/sidebarDragPreview.test.js`
Expected: FAIL because `src/workbench/sidebarDragPreview.js` does not exist.

- [ ] **Step 3: Implement the helper**

```js
function normalizePosition(position) {
  return position === "after" ? "after" : "before";
}

export function previewDragOrder(list, sourceId, targetId, { position = "before", getKey = (item) => item } = {}) {
  const items = Array.isArray(list) ? [...list] : [];
  const normalizedPosition = normalizePosition(position);
  const sourceIndex = items.findIndex((item) => String(getKey(item)) === String(sourceId));
  const targetIndex = items.findIndex((item) => String(getKey(item)) === String(targetId));
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;

  const [sourceItem] = items.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = items.findIndex((item) => String(getKey(item)) === String(targetId));
  const insertIndex = normalizedPosition === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
  items.splice(insertIndex, 0, sourceItem);
  return items;
}

export function sameDragTarget(target, kind, id, position = "before") {
  return (
    target?.kind === kind &&
    String(target?.id ?? "") === String(id ?? "") &&
    normalizePosition(target?.position) === normalizePosition(position)
  );
}
```

- [ ] **Step 4: Run helper tests to verify GREEN**

Run: `node --test src/workbench/sidebarDragPreview.test.js`
Expected: PASS.

### Task 2: Sidebar Live Preview Rendering

**Files:**
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing structure tests**

Add assertions to the existing `"sidebar connection and database nodes support drag reorder"` test:

```js
  assert.match(sidebar, /previewDragOrder/);
  assert.match(sidebar, /previewConnections/);
  assert.match(sidebar, /previewDatabases/);
  assert.match(sidebar, /TransitionGroup/);
  assert.match(sidebar, /name="wb-tree-reorder"/);
  assert.match(sidebar, /is-drag-preview-target/);
```

- [ ] **Step 2: Run structure test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`
Expected: FAIL because the sidebar does not yet use preview ordering or transition groups.

- [ ] **Step 3: Wire preview state into the sidebar**

In `WorkbenchSidebar.vue`:
- Import `computed` from Vue.
- Import `previewDragOrder` and `sameDragTarget`.
- Extend drag state with `targetPosition`.
- Add `previewConnections` and `previewDatabases` computed arrays.
- Update `markDragTarget` to save before/after position from `dropPosition(event)`.
- Update `dropConnection` and `dropDatabase` to use `dragState.targetPosition`.
- Render `previewConnections` and `previewDatabases`.
- Wrap connection and database loops in `<TransitionGroup name="wb-tree-reorder" tag="div">`.
- Add target class via `sameDragTarget`.

- [ ] **Step 4: Run structure test to verify GREEN**

Run: `node --test src/workbench/workbenchShell.test.js`
Expected: PASS.

### Task 3: Motion Styling And Full Verification

**Files:**
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing CSS assertions**

Add assertions to the sidebar drag reorder shell test:

```js
  assert.match(styles, /\.wb-tree-reorder-move/);
  assert.match(styles, /\.wb-tree-row\.is-drag-preview-target/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
```

- [ ] **Step 2: Run structure test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`
Expected: FAIL because reorder motion CSS is missing.

- [ ] **Step 3: Add CSS motion**

Add CSS rules for `.wb-tree-reorder-move`, `.wb-tree-row.is-dragging-source`, `.wb-tree-row.is-drag-preview-target`, and reduced-motion overrides. Use transform, opacity, box-shadow, and existing tokens.

- [ ] **Step 4: Run full JS tests**

Run: `node --test src/workbench`
Expected: PASS.

- [ ] **Step 5: Run frontend build**

Run: `npm run build`
Expected: PASS.

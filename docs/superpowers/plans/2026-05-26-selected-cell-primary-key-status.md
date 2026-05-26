# Selected Cell Primary Key Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the focused data cell's real row primary-key identity beside the footer row count, including composite-key and range-selection context.

**Architecture:** Add a pure presentation-model utility that resolves the selected loaded row and formats only real primary-key metadata from `tab.primaryKeys`. Render that model through a focused Vue footer component mounted by `MySqlWorkbench.vue`, with styles limited to the existing status bar.

**Tech Stack:** Vue 3 `<script setup>`, JavaScript ES modules, Node.js `node:test`, Vite CSS.

---

## File Structure

- Create `src/workbench/utils/selectedCellIdentity.js`: pure identity formatting and range-count calculation, with no Vue or backend dependencies.
- Create `src/workbench/selectedCellIdentity.test.js`: unit coverage for single, composite, missing-key, range, null/empty, and hidden states.
- Create `src/workbench/components/SelectedCellIdentity.vue`: footer-only presentation component consuming the utility model.
- Modify `src/workbench/MySqlWorkbench.vue`: import and mount the component after the existing row-count section.
- Modify `src/workbench/workbench.css`: add compact footer identity styles using the existing design tokens.
- Modify `src/workbench/workbenchShell.test.js`: protect component wiring and styling contracts.

The current workspace already has in-progress modifications in
`MySqlWorkbench.vue`, `workbench.css`, and `workbenchShell.test.js`. Changes in
those files must be layered onto the existing work and must not be staged or
committed independently from the owner of those overlapping edits.

### Task 1: Selected Identity Presentation Model

**Files:**
- Create: `src/workbench/selectedCellIdentity.test.js`
- Create: `src/workbench/utils/selectedCellIdentity.js`

- [x] **Step 1: Write the failing unit tests**

Create `src/workbench/selectedCellIdentity.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildRowKey } from "./utils/rowIdentity.js";
import { buildSelectedCellIdentity } from "./utils/selectedCellIdentity.js";

function makeTab(overrides = {}) {
  return {
    id: "tab-1",
    primaryKeys: ["id"],
    columns: [{ column_name: "id" }, { column_name: "name" }],
    rows: [{ id: "10021", name: "Alice" }],
    ...overrides,
  };
}

function focus(tab, row = tab.rows[0], column = "name") {
  return { tabId: tab.id, rowKey: buildRowKey(tab, row), column };
}

test("builds a single-primary-key identity for the focused cell", () => {
  const tab = makeTab();
  const identity = buildSelectedCellIdentity(tab, focus(tab), null);

  assert.deepEqual(identity, {
    column: "name",
    keyLabel: "主键",
    primaryKeyText: "id=10021",
    selectedCount: 0,
    title: "当前单元格 name | 主键 id=10021",
  });
});

test("labels composite keys and preserves key order", () => {
  const tab = makeTab({
    primaryKeys: ["server_id", "role_id"],
    columns: [{ column_name: "server_id" }, { column_name: "role_id" }, { column_name: "quantity" }],
    rows: [{ server_id: 3, role_id: "10021", quantity: 9 }],
  });

  const identity = buildSelectedCellIdentity(tab, focus(tab, tab.rows[0], "quantity"), null);

  assert.equal(identity.keyLabel, "多主键");
  assert.equal(identity.primaryKeyText, "server_id=3 + role_id=10021");
});

test("does not expose fallback row identity for a table without a primary key", () => {
  const tab = makeTab({ primaryKeys: [] });
  const identity = buildSelectedCellIdentity(tab, focus(tab), null);

  assert.equal(identity.keyLabel, "无主键");
  assert.equal(identity.primaryKeyText, "");
  assert.equal(identity.title, "当前单元格 name | 无主键");
  assert.doesNotMatch(identity.title, /10021|Alice/);
});

test("shows the focus row identity and cell count for a range", () => {
  const tab = makeTab({ rows: [{ id: "10021", name: "Alice" }, { id: "10022", name: "Bob" }] });
  const range = {
    tabId: tab.id,
    anchor: { rowIndex: 0, columnIndex: 0 },
    focus: { rowIndex: 1, columnIndex: 1 },
  };

  const identity = buildSelectedCellIdentity(tab, focus(tab, tab.rows[1]), range);

  assert.equal(identity.primaryKeyText, "id=10022");
  assert.equal(identity.selectedCount, 4);
  assert.equal(identity.title, "当前单元格 name | 主键 id=10022 | 已选 4 个单元格");
});

test("formats anomalous key values without ambiguity", () => {
  const tab = makeTab({
    primaryKeys: ["left_id", "right_id"],
    rows: [{ left_id: null, right_id: "", name: "orphan" }],
  });

  assert.equal(
    buildSelectedCellIdentity(tab, focus(tab), null).primaryKeyText,
    'left_id=NULL + right_id=""',
  );
});

test("hides identity when the focused row is absent or belongs to another tab", () => {
  const tab = makeTab();

  assert.equal(buildSelectedCellIdentity(tab, null, null), null);
  assert.equal(buildSelectedCellIdentity(tab, { tabId: "other", rowKey: "id=10021", column: "name" }, null), null);
});
```

- [x] **Step 2: Run the unit test to verify RED**

Run: `node --test src/workbench/selectedCellIdentity.test.js`

Expected: FAIL because `./utils/selectedCellIdentity.js` does not yet exist.

- [x] **Step 3: Implement the pure presentation model**

Create `src/workbench/utils/selectedCellIdentity.js`:

```js
import { findRowByKey } from "./rowIdentity.js";

function formatPrimaryKeyValue(value) {
  if (value == null) return "NULL";
  if (value === "") return '""';
  return String(value);
}

function selectedCellCount(tab, selectedRange) {
  if (!selectedRange || selectedRange.tabId !== tab.id) return 0;
  const rowCount = Math.abs(selectedRange.focus.rowIndex - selectedRange.anchor.rowIndex) + 1;
  const columnCount = Math.abs(selectedRange.focus.columnIndex - selectedRange.anchor.columnIndex) + 1;
  const count = rowCount * columnCount;
  return count > 1 ? count : 0;
}

export function buildSelectedCellIdentity(tab, selectedCell, selectedRange) {
  if (!tab || !selectedCell || selectedCell.tabId !== tab.id) return null;
  const row = findRowByKey(tab, selectedCell.rowKey);
  if (!row) return null;

  const primaryKeys = Array.isArray(tab.primaryKeys) ? tab.primaryKeys.filter(Boolean) : [];
  const keyLabel = primaryKeys.length === 0 ? "无主键" : primaryKeys.length === 1 ? "主键" : "多主键";
  const primaryKeyText = primaryKeys
    .map((key) => `${key}=${formatPrimaryKeyValue(row[key])}`)
    .join(" + ");
  const selectedCount = selectedCellCount(tab, selectedRange);
  const title = [
    `当前单元格 ${selectedCell.column}`,
    primaryKeyText ? `${keyLabel} ${primaryKeyText}` : keyLabel,
    selectedCount ? `已选 ${selectedCount} 个单元格` : "",
  ].filter(Boolean).join(" | ");

  return {
    column: String(selectedCell.column || ""),
    keyLabel,
    primaryKeyText,
    selectedCount,
    title,
  };
}
```

- [x] **Step 4: Run the unit test to verify GREEN**

Run: `node --test src/workbench/selectedCellIdentity.test.js`

Expected: PASS with 6 tests and 0 failures.

### Task 2: Footer Component And Shell Integration

**Files:**
- Create: `src/workbench/components/SelectedCellIdentity.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

- [x] **Step 1: Add failing shell-wiring assertions**

In the existing `navigation and tabs expose each table database source` test
in `src/workbench/workbenchShell.test.js`, add:

```js
  const identity = read("./components/SelectedCellIdentity.vue");
  assert.match(orchestrator, /import\s+SelectedCellIdentity/);
  assert.match(orchestrator, /<SelectedCellIdentity/);
  assert.match(orchestrator, /:selected-cell="selectedCell"/);
  assert.match(orchestrator, /:selected-range="selectedRange"/);
  assert.match(identity, /buildSelectedCellIdentity/);
  assert.match(identity, /wb-cell-identity/);
  assert.match(identity, /:title="identity\.title"/);
  assert.match(styles, /\.wb-cell-identity/);
  assert.match(styles, /\.wb-cell-identity-key/);
  const identityRule = styles.match(/\.wb-cell-identity\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(identityRule, /overflow:\s*hidden/);
  assert.match(styles, /\.wb-cell-identity-key\s*\{[^}]*text-overflow:\s*ellipsis/s);
```

- [x] **Step 2: Run the shell test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because `SelectedCellIdentity.vue` and its wiring do not yet
exist.

- [x] **Step 3: Add the rendering component**

Create `src/workbench/components/SelectedCellIdentity.vue`:

```vue
<script setup>
import { computed } from "vue";
import { buildSelectedCellIdentity } from "../utils/selectedCellIdentity.js";

const props = defineProps({
  tab: { type: Object, default: null },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
});

const identity = computed(() =>
  buildSelectedCellIdentity(props.tab, props.selectedCell, props.selectedRange),
);
</script>

<template>
  <section
    v-if="identity"
    class="wb-cell-identity"
    :title="identity.title"
    aria-label="当前单元格身份"
  >
    <span class="wb-cell-identity-label">当前单元格</span>
    <strong class="wb-cell-identity-column">{{ identity.column }}</strong>
    <span class="wb-cell-identity-divider" aria-hidden="true"></span>
    <span class="wb-cell-identity-label">{{ identity.keyLabel }}</span>
    <strong v-if="identity.primaryKeyText" class="wb-cell-identity-key">{{ identity.primaryKeyText }}</strong>
    <template v-if="identity.selectedCount">
      <span class="wb-cell-identity-divider" aria-hidden="true"></span>
      <span class="wb-cell-identity-count">已选 {{ identity.selectedCount }} 个单元格</span>
    </template>
  </section>
</template>
```

- [x] **Step 4: Mount the component in the status bar**

In `src/workbench/MySqlWorkbench.vue`, import the component:

```js
import SelectedCellIdentity from "./components/SelectedCellIdentity.vue";
```

After the existing `.wb-sidebar-status` section in `.wb-grid-statusbar`, add:

```vue
      <SelectedCellIdentity
        :tab="activeTab"
        :selected-cell="selectedCell"
        :selected-range="selectedRange"
      />
```

- [x] **Step 5: Style the compact footer item**

Add to `src/workbench/workbench.css` adjacent to the existing footer status
rules:

```css
.wb-cell-identity {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  overflow: hidden;
  color: var(--wb-muted);
  font-size: 11px;
  white-space: nowrap;
}

.wb-cell-identity-label,
.wb-cell-identity-count {
  flex: 0 0 auto;
  color: var(--wb-muted);
}

.wb-cell-identity-column {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text);
  font-weight: 520;
  text-overflow: ellipsis;
}

.wb-cell-identity-key {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-accent-strong);
  font-variant-numeric: tabular-nums;
  font-weight: 620;
  text-overflow: ellipsis;
}

.wb-cell-identity-divider {
  flex: 0 0 auto;
  width: 1px;
  height: 12px;
  background: var(--wb-line);
}
```

- [x] **Step 6: Run focused tests to verify GREEN**

Run:

```bash
node --test src/workbench/selectedCellIdentity.test.js src/workbench/workbenchShell.test.js
```

Expected: PASS with 0 failures.

### Task 3: Regression Verification

**Files:**
- Verify only; no intended source changes.

- [x] **Step 1: Run all JavaScript workbench tests**

Run: `node --test src/workbench/*.test.js`

Expected: PASS with 0 failures, including the new selected identity tests.

- [x] **Step 2: Run the frontend production build**

Run: `npm run build`

Expected: Vite exits successfully and writes the frontend bundle to `dist/`.

- [x] **Step 3: Review the final diff boundary**

Run:

```bash
git diff -- src/workbench/utils/selectedCellIdentity.js src/workbench/selectedCellIdentity.test.js src/workbench/components/SelectedCellIdentity.vue src/workbench/MySqlWorkbench.vue src/workbench/workbench.css src/workbench/workbenchShell.test.js
git status --short --branch --untracked-files=all
```

Expected: Newly created feature files are identifiable, and edits to the three
overlapping existing files retain the user's prior footer and grid styling
work. Do not commit those overlapping files without the user's broader change
set being intentionally included.

# Readable Metadata And Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make database names, field structure, remarks, and supporting workbench text legible in light and dark themes while preserving the compact table-browser layout.

**Architecture:** Keep this as a presentation-only change. `InspectorPanel.vue` exposes explicit semantic roles for field metadata and selected-column feedback; `workbench.css` owns typography and semantic theme tokens used throughout existing panes; the existing shell test pins those class and token contracts without changing state or backend interfaces.

**Tech Stack:** Vue 3 `<script setup>`, CSS custom properties, Node.js built-in test runner, Vite.

---

## File Structure

- Modify `src/workbench/workbenchShell.test.js`: add contract tests for semantic metadata markup, selected-field highlighting, and light/dark readability tokens.
- Modify `src/workbench/components/InspectorPanel.vue`: render field name, type, primary-key status, and remark as separate roles; mark the field matching the current selected grid cell.
- Modify `src/workbench/workbench.css`: add semantic type/remark/quiet/identifier tokens, improve UI font fallbacks, and assign readable roles across navigation, grid support text, inspector, status bar, and import/dialog helper content.

### Task 1: Inspector Semantic Field Structure

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/InspectorPanel.vue`

- [ ] **Step 1: Write the failing inspector structure test**

Append this test to `src/workbench/workbenchShell.test.js`:

```js
test("inspector exposes distinct field, type, key, and remark roles", () => {
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(inspector, /function\s+isSelectedColumn/);
  assert.match(inspector, /class="wb-schema-field-name"/);
  assert.match(inspector, /class="wb-schema-type-line"/);
  assert.match(inspector, /class="wb-schema-field-type"/);
  assert.match(inspector, /class="wb-schema-key-badge"/);
  assert.match(inspector, /class="wb-schema-field-comment"/);
  assert.match(inspector, /:class="\{\s*'is-selected':\s*isSelectedColumn\(column\)\s*\}"/);
  assert.match(inspector, /v-if="columnComment\(column\)"/);
});
```

- [ ] **Step 2: Run the test to verify it fails for missing semantic roles**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Expected: FAIL in `inspector exposes distinct field, type, key, and remark roles` because `.wb-schema-field-name` and the other new inspector roles do not yet exist.

- [ ] **Step 3: Implement explicit inspector metadata roles**

In `src/workbench/components/InspectorPanel.vue`, add helpers after `columnComment()`:

```js
function columnType(column) {
  return column.column_type || column.columnType || "";
}

function isPrimaryKey(column) {
  return Boolean(column.is_primary_key || column.isPrimaryKey);
}

function isSelectedColumn(column) {
  return (
    props.activeTab?.id === props.selectedCell?.tabId &&
    columnName(column) === props.selectedCell?.column
  );
}
```

Replace the field-row template with the semantic structure:

```vue
<article
  v-for="column in activeColumns"
  :key="columnName(column)"
  :class="{ 'is-selected': isSelectedColumn(column) }"
>
  <span class="wb-object-icon" data-kind="column"></span>
  <span class="wb-schema-field-copy">
    <strong class="wb-schema-field-name">{{ columnName(column) }}</strong>
    <span class="wb-schema-type-line">
      <em class="wb-schema-field-type">{{ columnType(column) }}</em>
      <span v-if="isPrimaryKey(column)" class="wb-schema-key-badge">主键</span>
    </span>
    <small v-if="columnComment(column)" class="wb-schema-field-comment">{{ columnComment(column) }}</small>
  </span>
</article>
```

- [ ] **Step 4: Run the inspector test to verify the markup contract passes**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Expected: PASS for the new inspector role test and all existing shell tests.

- [ ] **Step 5: Commit the semantic inspector change**

```powershell
git add -- src/workbench/workbenchShell.test.js src/workbench/components/InspectorPanel.vue
git commit -m "feat: separate inspector metadata roles"
```

### Task 2: Semantic Theme Tokens And Readable Typography

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Write the failing semantic palette test**

Append this test to `src/workbench/workbenchShell.test.js`:

```js
test("semantic text tokens keep type and remark content readable in both themes", () => {
  const styles = read("./workbench.css");

  for (const token of [
    "--wb-font-ui",
    "--wb-identifier-text",
    "--wb-type-text",
    "--wb-remark-text",
    "--wb-quiet-text",
  ]) {
    assert.match(styles, new RegExp(`${token}:`), `missing semantic text token: ${token}`);
  }

  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-type-text:/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-remark-text:/);
  assert.match(styles, /\.wb-schema-field-type\s*\{[^}]*color:\s*var\(--wb-type-text\)/s);
  assert.match(styles, /\.wb-schema-field-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)/s);
  assert.match(styles, /\.wb-table-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)/s);
  assert.match(styles, /\.wb-sidebar-status-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)/s);
});
```

- [ ] **Step 2: Run the test to verify it fails for absent readability tokens**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Expected: FAIL in `semantic text tokens keep type and remark content readable in both themes` because the semantic text tokens have not yet been declared.

- [ ] **Step 3: Add semantic text tokens for both palettes**

In the `:root` token block in `src/workbench/workbench.css`, add the following tokens and replace the root `font-family` with `font-family: var(--wb-font-ui);`:

```css
  --wb-font-ui: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif;
  --wb-identifier-text: #17202a;
  --wb-type-text: #356481;
  --wb-remark-text: #4d5f70;
  --wb-quiet-text: #667789;
```

In `.mysql-workbench[data-theme="dark"]`, add:

```css
  --wb-identifier-text: #eef4fa;
  --wb-type-text: #8dc4ed;
  --wb-remark-text: #b8c6d4;
  --wb-quiet-text: #97a9bb;
```

- [ ] **Step 4: Apply text roles to navigation, grid support text, status, dialogs, and inspector**

Keep existing geometry and replace role styling with these targeted rules in `src/workbench/workbench.css`:

```css
.wb-pane-header span,
.wb-text-panel > div > span {
  color: var(--wb-remark-text);
}

.wb-database-item,
.wb-tree-empty,
.wb-grid-loading,
.wb-empty,
.wb-import-file-area,
.wb-import-info,
.wb-import-summary p,
.wb-dialog-field {
  color: var(--wb-secondary-text);
}

.wb-table-comment,
.wb-sidebar-status-comment {
  color: var(--wb-remark-text);
  font-size: 11px;
}

.wb-tab-title small,
.wb-import-col-type {
  color: var(--wb-type-text);
}

.wb-row-index,
.is-null input,
.is-null .wb-cell-text,
.wb-table-search input::placeholder,
.wb-table-toolbar input::placeholder,
.wb-detail-input::placeholder {
  color: var(--wb-quiet-text);
}

.wb-schema-list article {
  border-radius: 6px;
}

.wb-schema-list article.is-selected {
  border-color: color-mix(in srgb, var(--wb-accent) 30%, transparent);
  background: var(--wb-accent-soft);
}

.wb-schema-field-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.wb-schema-field-name {
  color: var(--wb-identifier-text);
}

.wb-schema-type-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.wb-schema-field-type {
  color: var(--wb-type-text);
  font-size: 11px;
  font-style: normal;
  font-weight: 550;
}

.wb-schema-key-badge {
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-size: 10px;
  font-weight: 650;
}

.wb-schema-field-comment {
  color: var(--wb-remark-text);
  font-size: 11px;
  line-height: 1.45;
}
```

Where the existing grouped selector directly styles `.wb-schema-list em` and
`.wb-schema-list small` with `--wb-muted`, remove those two selectors so the
new semantic role rules are authoritative.

- [ ] **Step 5: Run shell tests to verify the semantic palette contract passes**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Expected: PASS for all shell tests, including the new semantic token test.

- [ ] **Step 6: Commit the semantic theme change**

```powershell
git add -- src/workbench/workbenchShell.test.js src/workbench/workbench.css
git commit -m "feat: improve workbench metadata readability"
```

### Task 3: Full Verification And Visual Theme Inspection

**Files:**
- Verify: `src/workbench/components/InspectorPanel.vue`
- Verify: `src/workbench/workbench.css`
- Verify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Run all frontend unit tests**

Run:

```powershell
node --test src/workbench
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Build the frontend bundle**

Run:

```powershell
npm run build
```

Expected: exit code `0`; Vite may retain the existing chunk-size warning, but there must be no build errors.

- [ ] **Step 3: Inspect the local UI in light mode**

Run the development UI and open `http://127.0.0.1:1431` in the in-app browser:

```powershell
npm run dev
```

Verify:

- The left database/table browser remains a compact single tree.
- Database labels and table remarks can be read without relying on active selection.
- The right inspector visibly separates field names, SQL types, primary-key tags, and remarks.
- Selecting a grid cell highlights the matching inspector field without changing table behavior.
- Bottom-bar table comments and selected-cell labels remain readable within the fixed footer.

- [ ] **Step 4: Toggle dark theme and inspect the same roles**

Use the bottom-right theme control and verify:

- Type text remains distinct from neutral remarks.
- Remarks and empty/loading/helper messages are readable on dark surfaces.
- Accent fills and key badges remain understated rather than overwhelming the data grid.
- No panel, tree, grid, dialog, or status content becomes clipped or overlapped.

- [ ] **Step 5: Review the final diff and report concrete evidence**

Run:

```powershell
git status --short --branch
git diff --stat HEAD~2..HEAD
```

Expected: only the approved metadata readability implementation, its tests,
and already-approved planning documentation are present in the relevant commits.

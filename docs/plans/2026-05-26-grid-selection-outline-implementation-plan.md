# Grid Selection Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render single-cell and rectangular cell selections with an Excel-style uniform perimeter and appropriate fill treatment.

**Architecture:** Reuse the current `range-selected`, `range-*` perimeter, and `range-anchor` classes already emitted for virtualized cells. The correction stays presentation-only in CSS, with a shell-level regression contract that catches renewed internal border coloring or filled anchors.

**Tech Stack:** Vue 3, CSS design tokens, Node.js test runner, Vite.

---

### Task 1: Capture And Correct The Selection Visual Contract

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/workbench.css`

- [x] **Step 1: Write failing assertions for outline and fill behavior**

Extend the existing drag-range shell test to extract the `.range-selected`
rule and assert that it does not color cell borders. Require transparent
selected/anchor cell text backgrounds and explicit 2px inset perimeter
shadows on all four edge rules:

```js
const rangeSelectedRule = styles.match(/\.wb-grid td\.range-selected\s*\{([^}]*)\}/s)?.[1] || "";
assert.doesNotMatch(rangeSelectedRule, /border-color/);
assert.match(styles, /\.wb-grid td\.selected \.wb-cell-text\s*\{[^}]*background:\s*transparent/s);
assert.match(styles, /\.wb-grid td\.range-anchor \.wb-cell-text\s*\{[^}]*background:\s*transparent/s);
assert.match(styles, /--range-top-shadow:\s*inset 0 2px 0 0 var\(--wb-accent\)/);
assert.match(styles, /--range-bottom-shadow:\s*inset 0 -2px 0 0 var\(--wb-accent\)/);
assert.match(styles, /--range-left-shadow:\s*inset 2px 0 0 0 var\(--wb-accent\)/);
assert.match(styles, /--range-right-shadow:\s*inset -2px 0 0 0 var\(--wb-accent\)/);
```

- [x] **Step 2: Run the focused test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the current range rule sets `border-color`, gives
selected/anchor cells colored backgrounds, and omits a consistent explicit
stroke declaration on several edges.

- [x] **Step 3: Implement the CSS correction**

Keep the existing range fill on non-anchor range cells, but update these
declarations:

```css
.wb-grid td.selected .wb-cell-text {
  background: transparent;
}

.wb-grid td.range-selected {
  box-shadow: var(--range-top-shadow), var(--range-bottom-shadow), var(--range-left-shadow), var(--range-right-shadow);
}

.wb-grid td.range-anchor .wb-cell-text {
  background: transparent;
}

.wb-grid td.range-top {
  --range-top-shadow: inset 0 2px 0 0 var(--wb-accent);
}
```

Apply the corresponding explicit `2px` inset declaration for bottom, left,
and right edges, and remove `border-color` from `.range-selected`.

- [x] **Step 4: Run focused and full verification**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

Run: `node --test src/workbench/*.test.js && npm run build`

Expected: All Node tests pass and Vite build exits with code 0.

- [x] **Step 5: Verify visually**

Open the browser-only demo application. Click one data cell and confirm it has
an unfilled four-sided outline; drag a rectangular selection and confirm the
anchor remains unfilled, all other range cells use the soft tint, and only the
rectangle perimeter is emphasized.

### Task 2: Join Perimeter Segments Across Grid Seams

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Write failing assertions for continuous outline rendering**

Replace the contract that requires per-cell inset shadows with a contract for
pseudo-element perimeter strips. Require the selected range cells to anchor
absolute drawing, horizontal strips to overlap the next cell border by `1px`,
vertical strips to overlap the next row border by `1px`, and specific rules
for a range cell contributing both horizontal or both vertical edges:

```js
assert.match(styles, /\.wb-grid td\.range-selected\s*\{[^}]*position:\s*relative/s);
assert.doesNotMatch(rangeSelectedRule, /box-shadow/);
assert.match(styles, /\.wb-grid td\.range-top::before\s*\{[^}]*right:\s*-1px/s);
assert.match(styles, /\.wb-grid td\.range-bottom::before\s*\{[^}]*right:\s*-1px/s);
assert.match(styles, /\.wb-grid td\.range-left::after\s*\{[^}]*bottom:\s*-1px/s);
assert.match(styles, /\.wb-grid td\.range-right::after\s*\{[^}]*bottom:\s*-1px/s);
assert.match(styles, /\.wb-grid td\.range-top\.range-bottom::before/);
assert.match(styles, /\.wb-grid td\.range-left\.range-right::after/);
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the perimeter is currently made from independent inset
shadows that leave the native grid seam visible between selected cells.

- [ ] **Step 3: Implement joined perimeter strips**

Make `.range-selected` a positioning context. Replace the four inset shadow
variables with horizontal `::before` and vertical `::after` 2px accent strips
that extend `1px` across internal perimeter seams but stop at the range's
right and bottom corners. Add two-background versions for a single-row range
and a single-column range so both opposing edges remain visible.

- [ ] **Step 4: Verify the corrected outline**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

Run: `node --test src/workbench/*.test.js src/workbench/utils/*.test.js && npm run build`

Expected: All Node tests pass and Vite build exits with code 0.

- [ ] **Step 5: Inspect a rectangular range visually**

Open the demo table, drag over multiple rows and columns, and confirm the
perimeter does not show neutral one-pixel breaks at column or row seams.

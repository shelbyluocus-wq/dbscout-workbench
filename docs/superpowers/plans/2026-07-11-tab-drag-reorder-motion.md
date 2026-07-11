# Tab Drag Reorder Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the normal arrow cursor over the home tab and make neighboring tabs visibly slide aside as soon as a drag crosses the target tab midpoint.

**Architecture:** Preserve the existing computed preview order and midpoint-based drag targeting in `WorkbenchTabs.vue`. Add focused CSS regression coverage, then repair the transition precedence in `workbench.css` so Vue's transition-group FLIP transform can run without changing persisted tab state.

**Tech Stack:** Vue 3 transition groups, CSS transforms and media queries, Node.js `node:test`, browser drag-and-drop verification.

---

### Task 1: Lock The Two Interaction Regressions

**Files:**
- Modify: `src/workbench/homepageInteraction.test.js`
- Inspect: `src/workbench/components/WorkbenchTabs.vue`
- Inspect: `src/workbench/workbench.css`

- [ ] **Step 1: Add the failing home-tab cursor test**

Append this test to `src/workbench/homepageInteraction.test.js`:

```js
test("homepage tab keeps the normal arrow cursor", () => {
  const styles = read("./workbench.css");
  const homeCursorRule = styles.match(
    /\.wb-tab\[data-kind="home"\],\s*\n\.wb-tab\[data-kind="home"\] \*\s*\{([^}]*)\}/s,
  )?.[1] || "";

  assert.match(homeCursorRule, /cursor:\s*default/);
  assert.match(homeCursorRule, /user-select:\s*none/);
});
```

- [ ] **Step 2: Run the cursor test and verify RED**

Run:

```bash
node --test --test-name-pattern="homepage tab keeps the normal arrow cursor" src/workbench/homepageInteraction.test.js
```

Expected: FAIL because the home tab has no dedicated `cursor: default` and `user-select: none` rule.

- [ ] **Step 3: Add the failing reorder-motion precedence test**

Append this second test to `src/workbench/homepageInteraction.test.js`:

```js
test("tab drag preview keeps its transform transition after base tab styles", () => {
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");
  const moveRule = styles.match(/\.wb-tab\.wb-tab-reorder-move\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(tabs, /<TransitionGroup name="wb-tab-reorder"/);
  assert.match(tabs, /@dragover\.prevent\.stop="markTabDragTarget\(tab\.id, \$event\)"/);
  assert.match(moveRule, /transform\s+0\.18s\s+cubic-bezier\(0\.25,\s*1,\s*0\.5,\s*1\)/);
});
```

- [ ] **Step 4: Run the reorder-motion test and verify RED**

Run:

```bash
node --test --test-name-pattern="tab drag preview keeps its transform transition" src/workbench/homepageInteraction.test.js
```

Expected: FAIL because the current move rule is less specific than, and declared before, the base tab transition rule.

### Task 2: Apply The Minimal Cursor And Motion Fix

**Files:**
- Modify: `src/workbench/workbench.css`
- Test: `src/workbench/homepageInteraction.test.js`

- [ ] **Step 1: Add the home-tab cursor rule**

Immediately after the existing `.wb-tab[data-kind="home"]` block, add:

```css
.wb-tab[data-kind="home"],
.wb-tab[data-kind="home"] * {
  cursor: default;
  user-select: none;
}
```

- [ ] **Step 2: Make the FLIP move transition win the cascade**

Remove the earlier standalone `.wb-tab-reorder-move` rule. Immediately after the base `.wb-tab` rule, add this more specific rule so it retains the normal tab state transitions while adding transform movement:

```css
.wb-tab.wb-tab-reorder-move {
  transition:
    transform 0.18s cubic-bezier(0.25, 1, 0.5, 1),
    background-color 0.14s ease,
    border-color 0.14s ease,
    box-shadow 0.14s ease;
}
```

- [ ] **Step 3: Run the focused interaction tests and verify GREEN**

Run:

```bash
node --test src/workbench/homepageInteraction.test.js
```

Expected: all tests in the file PASS.

- [ ] **Step 4: Run related tab-state and CSS regression tests**

Run:

```bash
node --test src/workbench/workspaceState.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: all tests PASS, including home-tab pinning, tab reordering, and reduced-motion coverage.

### Task 3: Verify The User-Visible Drag Experience

**Files:**
- Verify: `src/workbench/components/WorkbenchTabs.vue`
- Verify: `src/workbench/workbench.css`

- [ ] **Step 1: Build the frontend**

Run:

```bash
npm run build
```

Expected: Vite production build exits with code 0.

- [ ] **Step 2: Start the browser development server**

Run:

```bash
npm run dev -- --host 127.0.0.1
```

Expected: Vite reports a local URL, normally `http://127.0.0.1:1431/`.

- [ ] **Step 3: Verify normal motion in the browser**

Open enough data tables to show at least three draggable tabs. Confirm the home label keeps the arrow cursor. Drag a table tab across a neighboring tab and hold the mouse button after crossing its midpoint; confirm the neighboring tab slides into its preview position before release, the dragged tab stays subdued, and release persists the preview order.

- [ ] **Step 4: Verify reduced motion**

Emulate `prefers-reduced-motion: reduce` and repeat the drag. Confirm the preview order still updates before release but the neighboring tab changes position without animation.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff --check
git diff -- src/workbench/homepageInteraction.test.js src/workbench/workbench.css
```

Expected: no whitespace errors and no changes outside the two implementation files.

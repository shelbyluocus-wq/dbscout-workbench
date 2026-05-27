# Inspector Readability And Detail Resize Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make database labels and field remarks easier to read, and let users resize the inspector detail editor vertically with drag and double-click reset.

**Architecture:** Preserve the current table-first layout. Add one inspector-local resize composable that provides a reactive detail height and drag/reset handlers, wire it into `InspectorPanel.vue`, and keep all visual changes in the existing CSS token system. Tests cover the composable interaction contract and shell/style integration.

**Tech Stack:** Vue 3 Composition API, CSS custom properties, Node.js built-in test runner, Vite.

---

### Task 1: Inspector Detail Resize State

**Files:**
- Create: `src/workbench/composables/useInspectorResize.js`
- Create: `src/workbench/useInspectorResize.test.js`

**Step 1: Write the failing composable test**

Add a focused Node test that imports `useInspectorResize()`, installs stubbed
`window` and `document.body.style`, gives the composable an inspector element
height, starts a left-button drag, sends an upward mouse move, and asserts that
the computed detail height grows. It should also assert that `resetDetailHeight()`
restores the default height and that the pointer lifecycle restores the body
cursor on mouse up.

**Step 2: Run the test to verify it fails**

Run: `node --test src/workbench/useInspectorResize.test.js`

Expected: FAIL because `./composables/useInspectorResize.js` does not yet exist.

**Step 3: Implement minimal resize state**

Create a composable with:

```js
import { computed, getCurrentInstance, onBeforeUnmount, ref } from "vue";

const DETAIL_DEFAULT_HEIGHT = 212;
const DETAIL_MIN_HEIGHT = 126;
const SCHEMA_MIN_HEIGHT = 112;
const FIXED_INSPECTOR_HEIGHT = 46;

export function useInspectorResize() {
  const inspectorRef = ref(null);
  const detailHeight = ref(DETAIL_DEFAULT_HEIGHT);
  const isDetailResizing = ref(false);
  const detailPanelStyle = computed(() => ({ height: `${detailHeight.value}px` }));
  // Clamp by inspector height, grow on upward mouse movement, clean up on
  // mouseup/unmount, reset to default, and support ArrowUp/ArrowDown/Home.
  return { inspectorRef, detailPanelStyle, isDetailResizing, onDetailDividerMouseDown, onDetailDividerKeydown, resetDetailHeight };
}
```

Use `row-resize` while dragging, and clamp so the upper remarks list retains
room above the detail editor.

**Step 4: Run the focused test to verify it passes**

Run: `node --test src/workbench/useInspectorResize.test.js`

Expected: PASS.

### Task 2: Wire The Inspector Separator

**Files:**
- Modify: `src/workbench/components/InspectorPanel.vue`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Add a failing shell contract test**

Require `InspectorPanel.vue` to import/use `useInspectorResize`, bind
`ref="inspectorRef"` at the inspector root, render a focusable
`role="separator"` element with `aria-orientation="horizontal"`, wire
`@mousedown`, `@dblclick`, and `@keydown`, and apply `detailPanelStyle` to
`.wb-text-panel`.

**Step 2: Run the shell test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because no inner inspector divider is currently rendered.

**Step 3: Implement the component wiring**

Import the composable, destructure its refs/handlers, attach the inspector
root ref, insert `.wb-inspector-divider` before `.wb-text-panel`, and bind the
detail section style. The existing editor value/update/save events remain
unchanged.

**Step 4: Run the focused tests**

Run: `node --test src/workbench/useInspectorResize.test.js src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 3: Readability And Divider Styling

**Files:**
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Add failing style assertions**

Require a dedicated `--wb-database-text` token in light and dark palettes, the
database item to use it, field remarks to use at least `12px` and improved line
height, and `.wb-inspector-divider` styling with a row-resize cursor and visible
focus/hover treatment.

**Step 2: Run the shell test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the database token, larger remark type, and divider
rules do not exist.

**Step 3: Implement token and layout styles**

Add readable light/dark `--wb-database-text` values; change only inactive
database labels to that token. Increase `.wb-schema-field-comment` font size
and line height. Convert `.wb-text-panel` to a non-shrinking flex column whose
editor fills the allocated height, and style `.wb-inspector-divider` as a thin,
discoverable horizontal handle using existing border/accent tokens.

**Step 4: Run focused tests**

Run: `node --test src/workbench/useInspectorResize.test.js src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 4: Verify The Finished UI

**Files:**
- Verify: `src/workbench/components/InspectorPanel.vue`
- Verify: `src/workbench/composables/useInspectorResize.js`
- Verify: `src/workbench/workbench.css`

**Step 1: Run all workbench unit tests**

Run: `node --test src/workbench`

Expected: PASS with no failed tests.

**Step 2: Build the frontend**

Run: `npm run build`

Expected: exit code `0`; an existing chunk size warning is acceptable.

**Step 3: Validate in the local browser**

Run `npm run dev`, open `http://127.0.0.1:1431`, and confirm in light and dark
themes that inactive database names are legible, field remarks are larger,
dragging the new divider changes editor height, and double-click restores the
default ratio without clipping either region.

**Step 4: Review and commit implementation changes**

Review `git diff`, then commit the code, tests, and this implementation plan as
the completed feature.

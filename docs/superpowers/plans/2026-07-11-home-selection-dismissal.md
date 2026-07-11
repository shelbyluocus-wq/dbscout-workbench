# Homepage Selection Dismissal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear homepage table selections after clicks elsewhere without breaking table-name selection, selection-based actions, or newly completed box selections.

**Architecture:** A small framework-free controller classifies document clicks and defers clearing until the current click finishes. `DatabaseHome.vue` owns listener lifecycle and existing selection state, while `DatabaseTableList.vue` emits one signal after a valid box selection so the controller can ignore the browser's immediate follow-up click.

**Tech Stack:** Vue 3 Composition API, JavaScript, Node.js `node:test`.

---

## File Map

- Create `src/workbench/homepageSelectionDismissal.js`: framework-free click classification and one-shot post-box-selection guard.
- Create `src/workbench/homepageSelectionDismissal.test.js`: behavior tests for preservation, deferred clearing, and guard reset.
- Modify `src/workbench/components/DatabaseHome.vue`: register the document listener and connect it to the existing homepage selection controller.
- Modify `src/workbench/components/DatabaseTableList.vue`: report valid box-selection completion.
- Modify `src/workbench/homepageInteraction.test.js`: verify the Vue wiring contract.

### Task 1: Selection Dismissal Controller

**Files:**
- Create: `src/workbench/homepageSelectionDismissal.test.js`
- Create: `src/workbench/homepageSelectionDismissal.js`

- [ ] **Step 1: Write the failing controller tests**

Create `homepageSelectionDismissal.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createHomepageSelectionDismissal } from "./homepageSelectionDismissal.js";

function createTarget({ inside = false, tableName = false } = {}) {
  return {
    inside,
    closest(selector) {
      return tableName && selector === ".wb-dbhome-object-name" ? this : null;
    },
  };
}

test("homepage selection is preserved for its table names and cleared after other clicks", () => {
  const scheduled = [];
  let clearCount = 0;
  const ownTableName = createTarget({ inside: true, tableName: true });
  const outside = createTarget();
  const dismissal = createHomepageSelectionDismissal({
    getRoot: () => ({ contains: (target) => target.inside }),
    clearSelection: () => { clearCount += 1; },
    scheduleClear: (callback) => scheduled.push(callback),
    scheduleGuardReset: () => {},
  });

  dismissal.handleDocumentClick({ target: ownTableName });
  assert.equal(scheduled.length, 0);

  dismissal.handleDocumentClick({ target: outside });
  assert.equal(clearCount, 0);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(clearCount, 1);
});

test("a valid box selection suppresses only its immediate follow-up click", () => {
  const scheduledClears = [];
  const scheduledGuardResets = [];
  const outside = createTarget();
  const dismissal = createHomepageSelectionDismissal({
    getRoot: () => ({ contains: () => false }),
    clearSelection: () => {},
    scheduleClear: (callback) => scheduledClears.push(callback),
    scheduleGuardReset: (callback) => scheduledGuardResets.push(callback),
  });

  dismissal.markBoxSelectionComplete();
  dismissal.handleDocumentClick({ target: outside });
  assert.equal(scheduledClears.length, 0);

  dismissal.handleDocumentClick({ target: outside });
  assert.equal(scheduledClears.length, 1);

  dismissal.markBoxSelectionComplete();
  scheduledGuardResets.at(-1)();
  dismissal.handleDocumentClick({ target: outside });
  assert.equal(scheduledClears.length, 2);
});
```

- [ ] **Step 2: Run the controller tests and verify RED**

Run:

```bash
node --test src/workbench/homepageSelectionDismissal.test.js
```

Expected: FAIL because `homepageSelectionDismissal.js` does not exist.

- [ ] **Step 3: Implement the controller**

Create `homepageSelectionDismissal.js`:

```js
export function createHomepageSelectionDismissal({
  getRoot,
  clearSelection,
  scheduleClear = (callback) => queueMicrotask(callback),
  scheduleGuardReset = (callback) => setTimeout(callback, 0),
} = {}) {
  let suppressNextClick = false;

  function markBoxSelectionComplete() {
    suppressNextClick = true;
    scheduleGuardReset(() => {
      suppressNextClick = false;
    });
  }

  function handleDocumentClick(event) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const target = event?.target;
    const root = getRoot?.();
    if (root?.contains?.(target) && target?.closest?.(".wb-dbhome-object-name")) return;
    scheduleClear(() => clearSelection?.());
  }

  return {
    handleDocumentClick,
    markBoxSelectionComplete,
  };
}
```

- [ ] **Step 4: Run the controller tests and verify GREEN**

Run: `node --test src/workbench/homepageSelectionDismissal.test.js`

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the controller**

```bash
git add src/workbench/homepageSelectionDismissal.js src/workbench/homepageSelectionDismissal.test.js
git commit -m "feat(workbench): add homepage selection dismissal controller"
```

### Task 2: Vue Interaction Wiring

**Files:**
- Modify: `src/workbench/homepageInteraction.test.js`
- Modify: `src/workbench/components/DatabaseHome.vue`
- Modify: `src/workbench/components/DatabaseTableList.vue`

- [ ] **Step 1: Write the failing wiring contract test**

Append to `homepageInteraction.test.js`:

```js
test("homepage selection clears after clicks elsewhere without cancelling box selection", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(home, /createHomepageSelectionDismissal/);
  assert.match(home, /document\.addEventListener\("click",\s*selectionDismissal\.handleDocumentClick,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /document\.removeEventListener\("click",\s*selectionDismissal\.handleDocumentClick,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /@box-selection-complete="selectionDismissal\.markBoxSelectionComplete"/);
  assert.match(tableList, /emit\("box-selection-complete"\)/);
});
```

- [ ] **Step 2: Run the wiring test and verify RED**

Run:

```bash
node --test --test-name-pattern="selection clears after clicks elsewhere" src/workbench/homepageInteraction.test.js
```

Expected: FAIL because the controller is not wired and the table list does not emit box-selection completion.

- [ ] **Step 3: Report valid box selections from the table list**

Add `"box-selection-complete"` to the `defineEmits` list in `DatabaseTableList.vue`.

At the end of `finishBoxSelection`, keep the invalid-drag early return and emit the signal before replacing selection:

```js
  if (!box || box.width < 4 || box.height < 4) return;
  emit("box-selection-complete");
  emit("replace-selection", selected);
```

- [ ] **Step 4: Wire document click dismissal in the homepage**

Update the Vue import in `DatabaseHome.vue`:

```js
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
```

Import the controller:

```js
import { createHomepageSelectionDismissal } from "../homepageSelectionDismissal.js";
```

Add the root ref beside the existing refs and create the controller:

```js
const homeRootRef = ref(null);
const searchInputRef = ref(null);
const tableListRef = ref(null);
const selectionDismissal = createHomepageSelectionDismissal({
  getRoot: () => homeRootRef.value,
  clearSelection,
});
```

Register and remove the capture listener alongside the existing menu listener cleanup:

```js
onMounted(() => {
  document.addEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  document.removeEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
});
```

Attach the root ref and box-selection signal in the template:

```vue
<section ref="homeRootRef" class="wb-database-home" :class="{ 'is-readonly': readOnly }" @keydown.esc="closeMenu">
```

```vue
@box-selection-complete="selectionDismissal.markBoxSelectionComplete"
```

- [ ] **Step 5: Run the interaction and controller tests and verify GREEN**

Run:

```bash
node --test src/workbench/homepageSelectionDismissal.test.js src/workbench/homepageInteraction.test.js
```

Expected: 5 tests PASS.

- [ ] **Step 6: Commit the Vue wiring**

```bash
git add src/workbench/components/DatabaseHome.vue src/workbench/components/DatabaseTableList.vue src/workbench/homepageInteraction.test.js
git commit -m "fix(workbench): clear homepage selection after outside clicks"
```

### Task 3: Final Verification

**Files:**
- No production changes expected.

- [ ] **Step 1: Run focused regression tests**

Run:

```bash
node --test src/workbench/homepageSelectionDismissal.test.js src/workbench/homepageInteraction.test.js src/workbench/workspaceState.test.js src/workbench/utils/workspacePersistence.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run the affected shell contract**

Run:

```bash
node --test --test-name-pattern="navigation and tabs expose each table database source" src/workbench/workbenchShell.test.js
```

Expected: PASS. Do not modify the unrelated dirty portions of `workbenchShell.test.js`.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Vite production build succeeds. Existing bundle-size and mixed-import warnings may remain.

- [ ] **Step 4: Verify in the browser**

At `http://127.0.0.1:1431/` confirm:

1. Box-select two or more homepage tables and keep the resulting selected state.
2. Click a selected table name and confirm the normal selection behavior remains.
3. Click a comment, field count, homepage blank area, toolbar, tab bar, and sidebar; each click clears the selection.
4. Box-select again and confirm the new selection does not disappear immediately after pointer release.
5. Use a selection-based action and confirm it runs before the selection clears.

- [ ] **Step 5: Check final scope**

Run:

```bash
git diff --check
git status --short
```

Expected: feature files are committed, and all pre-existing staged, unstaged, and untracked user changes remain present and are not included in feature commits.

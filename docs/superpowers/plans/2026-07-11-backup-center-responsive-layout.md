# Backup Center Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the backup center snapshot controls and snapshot list in normal flow at every supported viewport size, and give the dialog close button a stable header-specific layout.

**Architecture:** Keep scrolling owned by the existing active tab panel. Make the snapshot-scope grid a non-shrinking flex child so it always occupies the natural height of its one- or two-column contents, then scope close-button layout changes with a backup-center-specific class so other dialogs remain unchanged.

**Tech Stack:** Vue 3 single-file components, CSS, Node.js `node:test`, browser-based visual verification.

---

### Task 1: Add layout regression coverage

**Files:**
- Modify: `src/workbench/backupCenterLayout.test.js`
- Test: `src/workbench/backupCenterLayout.test.js`

- [ ] **Step 1: Write the failing snapshot-flow test**

Add this test after the existing snapshot range layout test:

```js
test("snapshot scope keeps its natural height ahead of the snapshot list", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-backup-snapshot-layout\s*\{[^}]*flex:\s*none/s);
  assert.doesNotMatch(styles, /\.wb-backup-snapshot-layout\s*\{[^}]*min-height:\s*0/s);
  assert.match(styles, /@media\s*\(max-width:\s*980px\)\s*\{[\s\S]*\.wb-backup-snapshot-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});
```

- [ ] **Step 2: Write the failing close-button adaptation test**

Add this focused test:

```js
test("backup center close button has a stable header-specific target", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-dialog-close wb-backup-close"/);
  assert.match(styles, /\.wb-backup-header\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*width:\s*32px/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*height:\s*32px/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*justify-self:\s*end/s);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test src/workbench/backupCenterLayout.test.js
```

Expected: the two new tests fail because the snapshot layout still has `min-height: 0`, the header still uses flexbox, and the close button has no backup-specific class.

### Task 2: Fix layout ownership and close-button adaptation

**Files:**
- Modify: `src/workbench/components/BackupCenterDialog.vue:470`
- Modify: `src/workbench/workbench.css:1340`
- Modify: `src/workbench/workbench.css:2319`
- Test: `src/workbench/backupCenterLayout.test.js`

- [ ] **Step 1: Scope the close button to the backup center**

Change the existing close button class without changing its label or behavior:

```vue
<button type="button" class="wb-dialog-close wb-backup-close" :disabled="isBusy" aria-label="关闭备份中心" @click="emit('close')">×</button>
```

- [ ] **Step 2: Give the header stable three-column alignment**

Update the header and add the scoped close rule:

```css
.wb-backup-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  padding: 16px 18px 12px;
}

.wb-backup-user {
  justify-self: center;
}

.wb-backup-close {
  justify-self: end;
  width: 32px;
  height: 32px;
  min-height: 32px;
  margin: -4px -4px 0 0;
}
```

This keeps the identity centered while the close button remains independently anchored to the top-right.

- [ ] **Step 3: Prevent the snapshot-scope layout from shrinking**

Replace the shrinkable rule with:

```css
.wb-backup-snapshot-layout {
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1.12fr) minmax(300px, 0.88fr);
  align-items: stretch;
  gap: 10px;
}
```

The existing `@media (max-width: 980px)` rule remains responsible for stacking the two panels. Because the grid can no longer shrink, its natural stacked height stays ahead of the snapshot list and the active tab panel scrolls when necessary.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
node --test src/workbench/backupCenterLayout.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: all tests pass.

### Task 3: Browser verification

**Files:**
- Verify: `src/workbench/components/BackupCenterDialog.vue`
- Verify: `src/workbench/workbench.css`

- [ ] **Step 1: Verify desktop geometry**

Open the backup center snapshot tab at a 1280x720 viewport and measure the relevant rectangles. Confirm:

```text
snapshot layout bottom >= both scope-panel bottoms
snapshot list-header top >= snapshot layout bottom
close button width = 32
close button height = 32
```

- [ ] **Step 2: Verify narrow geometry**

At a viewport below the 980px breakpoint, confirm the two scope panels stack, the second panel ends before the snapshot-list header begins, and the active tab panel becomes vertically scrollable rather than overlapping content.

- [ ] **Step 3: Verify visual and interaction states**

Capture desktop and narrow screenshots. Confirm the close button is top-right aligned, its glyph is centered, hover/focus feedback remains visible, no text is clipped, and no new console errors appear.

- [ ] **Step 4: Run the focused tests once more**

Run:

```bash
node --test src/workbench/backupCenterLayout.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: all tests pass after browser verification.

# DB Scout Workbench UI/UX Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Turn the audited workbench into a clearer, safer, more attractive desktop database tool while preserving its dense virtualized grid and existing database behavior.

**Architecture:** Add small reusable UI state and behavior primitives, then apply them to the existing component/composable boundaries. Keep virtualization and backend contracts intact except where an already-implemented preview contract needs to be exposed. Deliver in test-first slices so layout, focus, pending state, and destructive flows remain independently verifiable.

**Tech Stack:** Vue 3 Composition API, CSS custom properties, Node `node:test`, Tauri 2, browser mock backend, Playwright CLI, Vite.

---

## Execution Rules

- Follow red-green-refactor for every behavior change.
- Do not stage or alter the pre-existing version/updater changes in `Cargo.lock`,
  `latest.json`, `package-lock.json`, `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, or `src/workbench/appVersion.js` unless a task
  explicitly requires the same line and the user change is preserved.
- The current UI baseline has five pre-existing focused-test failures. Never hide
  a new regression behind that baseline; run the affected test by exact name or
  file and compare failure output.
- Use existing mock mode for browser verification. Preserve grid and sidebar
  virtualization.
- Do not commit implementation work unless the user explicitly asks. The design
  document commit is already separate.
- Credential storage and HTTP/HTTPS Agent credential transport are outside this
  plan pending explicit authorization.

## Task 1: Shared Visual Tokens, Icons, Contrast, And Motion

**Files:**
- Create: `src/workbench/components/WorkbenchIcon.vue`
- Create: `src/workbench/workbenchVisualSystem.test.js`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/components/AgentPanel.vue`

**Step 1: Write failing visual-system tests**

Require:

```js
test("semantic visual tokens cover focus, status, type scale, and z layers", () => {
  assert.match(css, /--wb-focus-ring:/);
  assert.match(css, /--wb-success-text:/);
  assert.match(css, /--wb-info-text:/);
  assert.match(css, /--wb-z-dialog:/);
  assert.match(css, /--wb-control-size:\s*28px/);
});

test("primary chrome uses the shared icon component", () => {
  assert.match(shell, /import WorkbenchIcon/);
  assert.doesNotMatch(shell, /robot\.png/);
  assert.doesNotMatch(sidebar, /settings-white\.png|settings\.png/);
});

test("reduced motion disables transient and looping UI animation", () => {
  assert.match(css, /prefers-reduced-motion:[\s\S]*wb-save-reminder[\s\S]*animation:\s*none/);
  assert.match(css, /prefers-reduced-motion:[\s\S]*wb-ai-entry-button[\s\S]*animation:\s*none/);
});
```

Use Lucide-compatible 16px paths in `WorkbenchIcon.vue` for the small set used by
this plan: `bot`, `settings`, `plus`, `x`, `chevron-up`, `chevron-down`,
`panel-left`, `panel-right`, `expand`, `collapse`, `check`, `alert`, `info`, and
`database`. The component accepts `name`, `size`, and `strokeWidth`, uses
`currentColor`, and is always `aria-hidden` because the owning button supplies the
accessible name.

**Step 2: Verify RED**

Run:

```powershell
node --test src/workbench/workbenchVisualSystem.test.js
```

Expected: FAIL because the shared icon component and tokens do not exist.

**Step 3: Implement the visual foundation**

- Add semantic tokens for focus, success, warning, danger, info, control sizes,
  type sizes/weights, and z-index layers in both themes.
- Use one accessible blue-green accent for focus, selection, and primary actions.
- Raise dark Agent quiet/success/plan colors to at least 4.5:1 for normal text.
- Add `font-variant-numeric: tabular-nums` to grid/status numeric content.
- Replace the titlebar Agent mask and sidebar settings PNG with `WorkbenchIcon`.
- Replace visible Unicode close/dots icons only on surfaces touched by this plan.
- Consolidate all omitted animations into one final reduced-motion rule.
- Keep transitions at 150-200ms and avoid width/height animation where it causes
  actual layout work outside direct pane-resize affordances.

**Step 4: Verify GREEN**

Run:

```powershell
node --test src/workbench/workbenchVisualSystem.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: the new visual-system tests pass; any old source-regex baseline failures
must be documented rather than broadly rewritten.

## Task 2: Responsive Database Home Table

**Files:**
- Modify: `src/workbench/components/DatabaseTableList.vue`
- Modify: `src/workbench/components/DatabaseHome.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/useDatabaseHome.test.js`
- Modify: `src/workbench/workbenchCssPolish.test.js`

**Step 1: Write failing behavior and source tests**

Test exported layout helpers with this contract:

```js
export function databaseHomeColumns({ name, comment, fields }) {
  return `${name}px minmax(${comment}px, 1fr) ${fields}px`;
}
```

Require a 36px row constant, a minimum table width, full-surface `width: 100%`, and
complete-row hover/selected styles. Require separate empty copy for an empty
database and a zero-result query.

**Step 2: Verify RED**

```powershell
node --test src/workbench/useDatabaseHome.test.js src/workbench/workbenchCssPolish.test.js
```

Expected: FAIL on the new 36px/responsive/full-row assertions.

**Step 3: Implement**

- Change `ROW_HEIGHT` to 36 while keeping the same virtual range algorithm.
- Use `minmax(commentMin, 1fr)` so the comment column absorbs spare width.
- Give header, virtual surface, and rows `width: max(100%, <minimum>px)`.
- Move hover/selection background and focus treatment to the full row.
- Keep the name cell visually strongest without using a side stripe.
- Convert the invalid listbox/header mixture to a grid-style semantic structure or
  implement listbox semantics consistently; Task 9 completes the arrow-key model.
- Show `当前数据库暂无表` only when the source is empty and `没有匹配的表` only
  when a query removes all rows.

**Step 4: Verify GREEN and inspect both themes**

Run the focused tests, then capture 1440x900 light/dark home screenshots with no
blank inspector area and no unused horizontal canvas.

## Task 3: Adaptive Cell Detail And Pane Width Reconciliation

**Files:**
- Modify: `src/workbench/components/CellDetailPanel.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/composables/usePaneResize.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/usePaneResize.test.js`
- Create: `src/workbench/cellDetailLayout.test.js`
- Modify: `src/workbench/workbench.css`

**Step 1: Write failing pure-layout tests**

Export and test:

```js
fitPaneWidths({ available, sidebar, inspector, sidebarCollapsed, inspectorCollapsed, mainMin })
detailPanelHeight({ selected, parentHeight, preferredHeight, collapsedHeight, gridMinHeight })
```

Required cases:

- `available=1120`, sidebar/inspector `500/500` preserves `mainMin=400` and keeps
  both panes inside the viewport.
- Collapsed pane preferred widths remain remembered for later expansion.
- No selected cell returns the collapsed handle height.
- A 360px vertical split keeps at least 140px for the grid.
- A normal 900px window restores a compact 120px preferred detail height.

**Step 2: Verify RED**

```powershell
node --test src/workbench/usePaneResize.test.js src/workbench/cellDetailLayout.test.js
```

Expected: FAIL because the reconciliation helpers and adaptive detail behavior are
missing.

**Step 3: Implement pane reconciliation**

- Keep preferred stored widths separate from fitted live widths.
- Reconcile after mount, on window resize, and before expanding a pane.
- Reduce the two visible side panes proportionally down to their minimums, then
  collapse the less contextual pane if `MAIN_MIN` still cannot fit.
- Never write a temporary fitted width over the user's stored preferred width.

**Step 4: Implement adaptive detail behavior**

- Collapse when no cell is selected.
- Restore the last expanded height, defaulting to 120px, after selection.
- Add explicit expand/collapse icon buttons and retain keyboard/drag resizing.
- Auto-fit against the parent on mount and resize so a vertical split preserves a
  useful grid.
- Persist the preferred expanded height in local storage without persisting a
  constraint-induced temporary collapse.
- Accept a read-only prop and render `readonly`, a lock state, and explanatory copy
  before editing begins.

**Step 5: Verify GREEN and runtime geometry**

Assert `inspector.right <= innerWidth` after restored 500px widths at 1120x720.
Assert both 1280x720 vertical split grids are at least 140px tall.

## Task 4: Persistent Operation Status And Core Action Discovery

**Files:**
- Create: `src/workbench/utils/operationStatus.js`
- Create: `src/workbench/operationStatus.test.js`
- Create: `src/workbench/components/OperationStatusBar.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write failing status-state tests**

The helper exposes:

```js
createOperationStatusState({ initialText }) -> {
  text, tone, busy, progress, action, setStatus, clearStatus
}
```

`setStatus({ text, tone, busy, progress, action, persistent })` keeps error and
pending states until replaced or cleared. Success/info remains visible in the
status bar even after cell-local animation ends.

**Step 2: Verify RED**

```powershell
node --test src/workbench/operationStatus.test.js src/workbench/workbenchShell.test.js
```

**Step 3: Implement the status bar**

- Render a 24px bottom bar with connection/table context on the left and current
  operation, pending count, progress, and optional retry/dismiss action on the
  right.
- Keep a visually hidden live region, but do not make it the only status output.
- Add 24px bottom workspace allowance so the bar never overlays the grid.
- Preserve existing `statusText` assignments through a compatibility adapter while
  converting edited high-risk flows to explicit tones.
- Keep save reminders as secondary local feedback and make errors persistent.

**Step 4: Expose add-row from the toolbar**

Add a `plus` icon button named `新增行` beside other table actions, disabled with
an explicit read-only reason, and route it to the existing insert-draft logic.
The context-menu action remains available.

**Step 5: Preserve native editable context menus**

Add and test:

```js
export function shouldUseNativeContextMenu(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}
```

Do not call `preventDefault` or open a workbench menu for editable targets,
including inline grid editors and the Agent composer.

**Step 6: Verify GREEN**

Focused tests must pass. Browser-check success, pending, error, retry, read-only
add-row, and native textarea right-click behavior.

## Task 5: Unified Dialog Focus And Theme Behavior

**Files:**
- Create: `src/workbench/composables/useDialogFocus.js`
- Create: `src/workbench/useDialogFocus.test.js`
- Modify: `src/workbench/components/ConnectionDialog.vue`
- Modify: `src/workbench/components/ConfirmDialog.vue`
- Modify: `src/workbench/components/ShortcutSettingsDialog.vue`
- Modify: `src/workbench/components/DatabaseSyncDialog.vue`
- Modify: `src/workbench/components/TableCopyDialog.vue`
- Modify: `src/workbench/components/ImportWizardDialog.vue`
- Modify: `src/workbench/components/BatchImportDialog.vue`
- Modify: `src/workbench/components/BatchExportDialog.vue`
- Modify: `src/workbench/components/BackupCenterDialog.vue`
- Modify: `src/workbench/components/UpdateDialog.vue`
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

**Step 1: Write failing focus-controller tests**

The composable/controller must:

- remember the trigger,
- focus `[autofocus]` or the first enabled interactive control after open,
- cycle Tab and Shift+Tab,
- close only the topmost dialog on Escape,
- restore focus after close,
- make the application shell inert while a modal is active.

Expose a DOM-independent `nextDialogFocusIndex` helper for deterministic unit tests.

**Step 2: Verify RED**

```powershell
node --test src/workbench/useDialogFocus.test.js
```

**Step 3: Implement and integrate the primitive**

- Standardize `role="dialog"`, `aria-modal`, labelled titles, close labels, and
  refs on each listed dialog.
- Keep each specialized layout; do not nest generic cards around its content.
- Apply `wb-floating-themed` and `data-theme` to every Teleported dialog root.
- Add one topmost-dialog stack so nested backup confirmation cannot close two
  layers from one Escape press.
- Hide closed sidebar settings with `v-if` or `inert` plus `aria-hidden`, not just
  opacity and pointer events.
- Replace ad hoc table-rename and alias overlays with the same focus behavior.

**Step 4: Verify GREEN with Playwright**

For every representative dialog: opening moves focus inside, Tab remains inside,
Escape closes, focus returns to the trigger, and dark mode remains dark. Closed
settings must not appear in the accessibility tree or Tab order.

## Task 6: Pending-State Tabs And Unsaved-Work Guards

**Files:**
- Create: `src/workbench/utils/tabPendingState.js`
- Create: `src/workbench/tabPendingState.test.js`
- Modify: `src/workbench/components/TableDesignEditor.vue`
- Modify: `src/workbench/components/WorkbenchTabs.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write failing state tests**

Define:

```js
tabPendingState(tab) -> { kind: "clean|dirty|pending|saving|error", label, blocksClose }
```

Cover table-design drafts, insert drafts, pending cell saves, and per-tab errors.
Require a non-color-only marker and accessible tab name.

**Step 2: Verify RED**

```powershell
node --test src/workbench/tabPendingState.test.js src/workbench/workspaceState.test.js
```

**Step 3: Persist table-design drafts in the tab model**

- Move or mirror design draft/dirty state onto the design tab so switching tabs
  does not destroy unsaved work.
- `TableDesignEditor` emits draft state and consumes an existing tab draft on mount.
- Saving clears the dirty state; reset restores the loaded schema.

**Step 4: Guard close and force refresh**

- Before closing or force-refreshing a blocking tab, show Save, Discard, Cancel.
- Save routes to the active editor or activates the design tab before saving.
- Insert drafts use the existing commit path; failed save keeps the tab open.
- Discard explicitly clears the draft; Cancel changes nothing.
- `close all` processes dirty tabs predictably and stops on Cancel.

**Step 5: Verify GREEN and real switching behavior**

Create a design change, switch tabs, return, and confirm the draft remains. Verify
close/refresh choices for design and insert drafts.

## Task 7: Preview-First Sync, Honest Table Copy, And Import Risk Copy

**Files:**
- Modify: `src/workbench/components/DatabaseSyncDialog.vue`
- Modify: `src/workbench/composables/useDatabaseSync.js`
- Modify: `src/workbench/useDatabaseSync.test.js`
- Modify: `src/workbench/components/TableCopyDialog.vue`
- Modify: `src/workbench/composables/useTableCopy.js`
- Modify: `src/workbench/useTableCopy.test.js`
- Modify: `src/workbench/components/ImportWizardDialog.vue`
- Modify: `src/workbench/composables/useImportWizard.js`
- Modify: `src/workbench/useImportWizard.test.js`
- Modify: `src/workbench/workbench.css`

**Step 1: Write failing workflow tests**

Require:

- sync execute is disabled until a preview matching the current source/target and
  exclusions exists,
- changing configuration invalidates the preview,
- preview groups additions, replacements, removals, exclusions, and warnings,
- table-copy target connection is visible and focusable,
- one collision policy label is used in helper text and confirmation,
- import confirmation exposes partial-success behavior and result export.

**Step 2: Verify RED with focused files**

Run the three focused composable tests and record the expected missing-preview or
inconsistent-copy failures.

**Step 3: Implement sync preview state machine**

Use states `configuring -> previewing -> reviewed -> running -> succeeded|failed`.
The primary action is `预览变更` until reviewed, then `确认覆盖同步`. Display exact
target identity beside the final action.

**Step 4: Implement table-copy consistency**

- Remove the CSS that collapses the target connection selector.
- Use the backend's actual `_copy` collision behavior everywhere unless the backend
  contract is deliberately changed with tests.
- Clarify target connection/database and read-only state before execution.

**Step 5: Implement import disclosure and result**

Explain row-wise partial success before execution, keep successful/failed counts
visible, and expose the existing detailed failure rows as a complete result export
when possible without a backend contract change.

**Step 6: Verify GREEN and mock-mode flows**

No overwrite execution button may be enabled before preview. All copy confirmation
copy must match the result name returned by mock mode.

## Task 8: Find/Filter/Export Semantics And Search Cost

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/composables/useTableSearch.js`
- Modify: `src/workbench/useTableSearch.test.js`
- Modify: `src/workbench/composables/useExport.js`
- Modify: `src/workbench/useExport.test.js`
- Modify: `src/workbench/workbench.css`

**Step 1: Write failing semantic tests**

- A find query moves among loaded matches without silently changing export scope.
- A filter query is explicitly represented in the tab filter request.
- Export scope builder distinguishes `all` and `filtered`.
- Incremental expensive work is debounced and stale searches are canceled.

**Step 2: Verify RED**

Run the two focused composable test files.

**Step 3: Implement explicit modes**

- Label the compact toolbar control `查找` and make filter state an explicit chip
  or menu action.
- Keep Ctrl+F as find/navigation.
- When filtering, show mode, query, clear action, loading progress, and cancellation.
- Export with an active filter asks `导出全部行` or `导出当前筛选结果`.
- Debounce only backend-expanding work; local loaded-row navigation remains instant.

**Step 4: Verify GREEN and runtime behavior**

Verify selected-cell movement, filter visibility, request payload, export row scope,
and cancel behavior with real mock data.

## Task 9: Composite Widget Keyboard And ARIA Models

**Files:**
- Modify: `src/workbench/components/WorkbenchTabs.vue`
- Modify: `src/workbench/components/DatabaseTableList.vue`
- Modify: `src/workbench/components/QuickOpenPalette.vue`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/SidebarSearchPanel.vue`
- Modify: `src/workbench/workbenchShell.test.js`
- Create: `src/workbench/keyboardModel.test.js`

**Step 1: Write failing keyboard-model tests**

Cover pure index helpers for ArrowLeft/Right tab movement, ArrowUp/Down home-list
movement with Shift range extension, and Quick Open active descendant movement.
Require the DOM contracts:

- tab strip `role=tablist`, tabs `role=tab`, `aria-selected`, roving tabindex,
- database home one consistent grid/listbox model with keyboard selection,
- Quick Open combobox owns a listbox and sets `aria-activedescendant`,
- grid exposes the selected cell to assistive technology,
- search clear/history delete controls remain keyboard reachable.

**Step 2: Verify RED**

Run `keyboardModel.test.js` and the exact related shell tests.

**Step 3: Implement models without changing pointer behavior**

Keep existing single/double click and virtual rendering. Scroll the newly active
virtual item into view and never focus unmounted rows. Close buttons remain separate
interactive siblings rather than nested inside a tab button.

**Step 4: Verify GREEN with keyboard-only Playwright paths**

Open a table, move tabs, select multiple home rows, choose a Quick Open result,
move a grid selection, clear search, and close a tab without a pointer.

## Task 10: Agent Surface And Narrow-Pane Fallback

**Files:**
- Modify: `src/workbench/components/AgentPanel.vue`
- Modify: `src/workbench/components/AgentHeader.vue`
- Modify: `src/workbench/components/AgentComposer.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write failing surface tests**

Require Chinese empty-state copy, real suggestion buttons with Space/Enter behavior,
AA dark semantic tokens, shared icons, and a narrow inspector drawer state that
keeps Agent/notes reachable below the persistent-pane breakpoint.

**Step 2: Verify RED**

Run the exact Agent shell tests.

**Step 3: Implement**

- Change the heading to `想从这个数据库了解什么？`.
- Render concise action rows/buttons instead of decorative pills.
- Keep project state and database context visible without truncating the only
  meaningful label.
- At constrained widths, collapse the sidebar automatically when opening Agent or
  present Agent as a right drawer over a protected main width.
- Keep a visible button to switch between Agent and notes.
- Delay custom titlebar tooltips and remove duplicate native/custom tooltip output.

**Step 4: Verify GREEN**

Check 1024 effective width and the official 1120 minimum. The table must retain a
useful center width, Agent must remain reachable, and no toolbar may be covered.

## Task 11: Final Polish, Audit, And Regression Verification

**Files:**
- Modify only files already touched if verification finds defects.
- Add Playwright artifacts under `output/playwright/` only.

**Step 1: Run focused tests per task**

Every new test file and each affected existing test file must pass independently.

**Step 2: Run broad JS suites**

```powershell
node --test src/workbench
node --test sidecar
```

Report any pre-existing failures separately. No new or changed test may fail.

**Step 3: Run backend and build checks**

```powershell
Set-Location src-tauri
cargo check
Set-Location ..
npm run build
git diff --check
```

Expected: exit code 0 for checks affected by this work. The user's updater dependency
changes must not be reverted to satisfy an old source-regex test.

**Step 4: Run the complete Playwright acceptance matrix**

Validate light/dark at 1120x720, 1280x720, 1440x900, 1920x1080, and a 960x540
effective viewport. Include persisted 500px panes, vertical/horizontal splits,
database home, detail panel, status bar, dirty close, sync preview, copy/import,
dialog focus, settings Tab order, native editable context menu, reduced motion,
Agent drawer, and long Chinese copy.

Capture before/after screenshots at 1440x900 and 1120x720. Check page/root overflow,
inspector bounds, grid height, and focus programmatically rather than relying only
on screenshots.

**Step 5: Re-run the impeccable audit**

Score accessibility, performance, theming, responsive design, and anti-patterns.
Resolve remaining P0/P1 findings within the authorized UI/UX scope.

**Step 6: Request independent code review**

Review for regressions, virtual-scroll violations, lost state, focus traps, contrast,
and missing tests. Fix all Critical and Important findings, then repeat the relevant
verification commands.

**Step 7: Final scope audit**

Compare the final worktree against the design document requirement by requirement.
Do not claim completion until every listed UI/UX acceptance item has current runtime
or test evidence.

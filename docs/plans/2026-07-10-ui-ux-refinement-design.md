# UI/UX Refinement Design

**Status:** Approved by the user's up-front delegation on 2026-07-10

## Goal

Refine DB Scout Workbench into a quieter, clearer, and more trustworthy desktop
database instrument without replacing the dense grid workflow that already works.
The result should make state, risk, focus, and available actions obvious while
using workspace area more efficiently in light and dark themes.

## Product Scene

A developer or database operator uses the app for long maintenance and debugging
sessions on a Windows or macOS desktop, often with several tables open and a
narrower effective viewport caused by pane widths, split views, or display scaling.
The interface must disappear into the task: familiar controls, compact geometry,
legible state, and no decorative motion competing with data.

## Existing Strengths To Preserve

- The 28px virtualized data grid is compact and efficient.
- Light and dark themes already have broad semantic token coverage.
- Selection, pending edits, errors, frozen rows/columns, and read-only behavior
  have real state models rather than visual-only simulations.
- Sidebar and grid virtualization must remain intact.
- Browser mock mode must continue to support realistic end-to-end validation.

## Audit Summary

The core grid is not the weak point. The largest UX losses are around it:

1. The database home list uses only part of the available width, has oversized
   rows, and highlights only the name cell during multi-selection.
2. The cell detail editor reserves about 200px before a cell is selected and can
   leave vertically split panes with almost no usable grid.
3. Operational status is visually hidden; save reminders disappear after 1.3s,
   while persistent errors and pending work lack a stable home.
4. Dirty design drafts and insert rows can be lost when tabs are closed or
   refreshed, and tabs do not expose pending state.
5. Destructive workflows expose inconsistent or incomplete previews, especially
   database overwrite sync and table copy conflict behavior.
6. Dialogs do not share focus entry, focus trapping, background inertness, theme
   propagation, or focus restoration.
7. Restored pane widths can overflow the viewport; compact split panes and narrow
   high-scale windows do not have reliable adaptive fallbacks.
8. Agent status colors fail dark-theme contrast, the entry icon is visually rough,
   and the empty state mixes English with the Chinese product UI.
9. Hidden settings remain keyboard-focusable, several frequent targets are under
   24px, and composite widgets have incomplete ARIA keyboard models.
10. Search, filter, export scope, native context menus, and add-row discovery do
    not always match familiar desktop-workbench expectations.

## Approaches Considered

### 1. Cosmetic polish only

Adjust colors, shadows, radii, and typography while preserving all layout and
behavior. This is low risk but leaves the largest problems untouched: invisible
status, lost drafts, wasted space, focus leaks, and unsafe workflow ambiguity.

### 2. Instrument-grade refinement (selected)

Preserve the grid and information density, then improve the surrounding visual
system, adaptive layout, state feedback, safety flows, keyboard behavior, and
secondary surfaces. This has the best user impact without forcing users to learn a
new database tool.

### 3. Full visual rebrand

Replace the app shell with a more expressive Black Cat identity, stronger color,
larger surfaces, and more motion. This could look distinctive but would reduce
data density and trust, and would age faster than the restrained product register.

## Selected Design Direction

### Visual language

Use a restrained graphite/cool-neutral foundation with one accessible blue-green
interaction accent. The accent is reserved for focus, selection, primary actions,
and active state. Error, warning, success, and information each receive explicit
semantic tokens with AA contrast in both themes.

Use the existing system UI family, but normalize it to a small type scale and
four real font weights. Grid values use tabular numerals. Controls share a 28px
compact size, frequent icon targets are at least 24px, and all keyboard focus uses
one 2px focus-ring treatment.

Replace mixed PNG, CSS, Unicode, and mismatched inline icons on primary surfaces
with a single 16px current-color icon vocabulary. Motion communicates state in
150-200ms and is removed or made instantaneous under reduced motion.

### Workspace hierarchy

The titlebar, sidebar, tab strip, main surface, inspector, detail editor, and status
bar form one continuous workbench rather than translucent floating layers. Data is
the highest-contrast content; chrome is quieter but still legible.

The bottom status bar is always visible and compact. It shows connection/table
context, loading or operation progress, save/pending state, errors, and relevant
row counts. Errors remain visible until replaced or resolved; transient cell-local
feedback can remain as a secondary cue.

### Database home

- Reduce row height from 44px to 36px.
- Let the comment column absorb remaining width while preserving minimum widths.
- Apply hover and selected states to the complete row.
- Keep virtualization and desktop multi-select semantics.
- Clarify empty database versus zero search results.
- Ensure the inspector is either useful for the selected home object or yields its
  space to the table list; it must never show a blank 322px panel.

### Data grid and cell detail

- Keep the 28px grid rows and virtual-scroll behavior.
- Make add-row available from a clear toolbar icon as well as the context menu.
- Start the detail panel collapsed when no cell is selected.
- Restore a compact remembered height after selection, auto-collapse in constrained
  vertical split panes, and provide explicit expand/collapse controls in addition
  to dragging.
- Show read-only state before editing begins.
- Preserve native context menus in text inputs, editors, and Agent composition.

### Tabs and pending work

Every tab exposes a shared pending-state contract: clean, saving, pending, error,
or dirty. Tabs show a compact non-color-only marker and accessible label. Closing
or force-refreshing a dirty design or insert draft invokes a save/discard/cancel
decision instead of silently deleting work.

### Search, filtering, and export

Separate the two user intents in copy and behavior:

- Find: locate matches in the already loaded grid and move the active cell.
- Filter: constrain the visible/query result set and therefore the export scope.

When a filter is active, the UI shows a persistent filter chip and export explicitly
offers all rows or current filtered rows. Expensive incremental search is debounced,
shows progress, and remains cancelable.

### High-risk workflows

- Database overwrite sync becomes preview-first. The first action computes a diff;
  execution is enabled only after users see additions, replacements, exclusions,
  warnings, and the exact target database.
- Table copy exposes the target connection and database, uses one real collision
  policy, and uses the same policy in explanatory and confirmation copy.
- Delete confirmation identifies affected primary keys or table names and describes
  the actual audit/rollback path rather than claiming unconditional irreversibility.
- Import explains partial-success behavior before execution and exposes a complete
  failure result.

### Dialog primitive

Introduce one reusable dialog behavior layer used by modal surfaces:

- dialog semantics and labelled title,
- initial focus inside the dialog,
- Tab/Shift+Tab containment,
- background inertness,
- Escape handling owned by the topmost dialog,
- focus restoration to the trigger,
- light/dark theme inheritance for Teleported surfaces,
- consistent header, close icon, action order, busy state, and error region.

Existing specialized dialog layouts remain; the primitive standardizes behavior,
not content.

### Responsive and split behavior

- Clamp restored sidebar and inspector widths against the current workspace at
  startup and on resize, always protecting the main data minimum.
- Reconcile widths without overwriting the user's preferred expanded sizes.
- Auto-collapse nonessential detail regions when a vertical pane cannot preserve a
  useful grid height.
- Replace the narrow-window overlap hint with a non-overlapping compact banner or
  automatic pane fallback.
- Keep inspector and Agent reachable through an overlay/drawer fallback when the
  persistent right pane cannot fit.
- Validate at 1120x720, 1280x720, 1440x900, and 1920x1080, plus a 960x540 effective
  viewport to represent high display scaling.

### Agent surface

- Replace the low-resolution AI mask with the shared icon vocabulary.
- Localize the empty-state heading and make suggestion actions real buttons.
- Raise quiet/status colors to AA contrast in dark mode.
- Keep the composer anchored and preserve database context while the panel is open.
- On narrow layouts, protect enough center width to keep the active table usable.

## State And Component Boundaries

- A small status-state module owns visible operation level, text, progress, and
  persistence policy; composables report structured status instead of relying on
  error keywords alone.
- A tab pending-state helper aggregates table-design dirty state, insert drafts,
  pending saves, and per-tab errors for `WorkbenchTabs` and close guards.
- `usePaneResize` owns width reconciliation and exposes a resize-safe method.
- `CellDetailPanel` owns remembered detail height and compact/collapsed behavior but
  receives read-only and constrained-layout inputs from its pane.
- A dialog-focus composable or primitive owns modal keyboard behavior; individual
  dialogs keep their domain state and actions.
- Visual tokens remain in `workbench.css`, with Agent-specific semantic tokens in a
  single consolidated section.

## Error Handling

- Visible status uses semantic level plus text; it never infers all severity solely
  from Chinese keywords.
- Long operations expose progress and cancellation when the backend supports it.
- Errors remain visible in the status bar and near the relevant control.
- Empty, loading, permission failure, connection failure, and zero-result states use
  distinct copy and actions.
- Focus is never moved to a surface that is hidden, collapsed, or outside the
  viewport.

## Accessibility Target

WCAG 2.2 AA for contrast, focus visibility, names, modal behavior, and keyboard
operation. Desktop compact controls may use a 24px minimum pointer target where
44px would materially damage grid density, but primary actions remain 28-32px.
State is never communicated by color alone.

## Validation

Implementation follows test-first slices. Each slice requires a failing behavior
test before production changes, then focused tests, broad frontend tests, build,
and real browser verification.

The final Playwright matrix must verify:

- light and dark themes at all target desktop sizes,
- restored 500px pane widths at 1120x720 without clipping,
- horizontal and vertical split panes with usable grids,
- database home full-width rows and complete-row selection,
- detail panel collapsed/expanded/resized behavior,
- persistent success/error/pending status,
- dirty tab close and refresh decisions,
- preview-first sync and consistent table-copy copy,
- modal focus entry, containment, Escape, and restoration,
- closed settings removed from the Tab order,
- native context menus in editable fields,
- reduced-motion behavior,
- Agent theme contrast, localization, and narrow-pane behavior.

## Non-Goals

- No wholesale grid rewrite or replacement of existing virtualization.
- No marketing-style shell, decorative dashboard, or animated rebrand.
- No mobile-phone product redesign; the narrow case is a desktop/high-scale fallback.
- Credential storage, HTTPS enforcement, and migration to the operating-system
  credential vault are a separate security project because they require explicit
  authorization and backend migration work.

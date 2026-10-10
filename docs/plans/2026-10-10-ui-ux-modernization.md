# UI/UX Modernization Pass

**Date:** 2026-10-10

## Goal

Audit the current workbench and remove the friction that made it feel
unfinished: missing feedback, misaligned lists, mixed languages, and surfaces
that pop instead of easing in. Keep the dense, keyboard-first workbench and
every deliberate product decision (no bottom status bar, collapsed sidebar on
first launch, slate default theme).

## Audit Findings

Evidence comes from browser screenshots of the mock backend (light/dark,
English/Simplified/Traditional Chinese, 1120–1440px wide) and from the source.

1. **Operation results were invisible.** About 240 `statusText` writes — including
   "commit transaction failed", "save SQL failed", "insert rows not saved" and
   every "can't paste/fill" explanation — only reached a visually hidden live
   region. A repeated failure did not even re-announce, because assigning the
   same string to a ref does not trigger.
2. **Database home list.** Header labels were centred by `space-between` while
   values were left-aligned; reorder grips (`⠿`) showed on every header; the
   sort arrow floated away from its label; sizes were left-aligned; rows had no
   hover state; selection boxed only the name cell; 27 outlined stars added
   noise; the comment column was clipped instead of truncated in narrow panes;
   Ctrl/Shift+click only worked on the name cell.
3. **Grid header.** A font glyph (`▾`) sat at 35% opacity on every column and
   collided with right-aligned numeric labels; the comments-row toggle read
   "注▲" / "Notes ▴" (truncated in English); the sort menu's shadow declaration
   was invalid, so the menu had no elevation.
4. **Inspector.** Three lines per field (≈73px) with a `||` icon that read as a
   pause button; on the home page with no selection it showed an empty header
   and a dead search box.
5. **Mixed languages.** Simplified Chinese leaked into the English and
   Traditional Chinese interfaces: grid freeze menu items, table-design column
   headers, AI panel suggestions/placeholder/project hints, search hit kinds
   ("字段"), batch export labels, a favorite button label; English showed
   "27 / 27 preselected tables".
6. **Design-system drift.** 27 font sizes (including half pixels), ten font
   weights, 13 radii and roughly 20 transition durations; dialogs and menus
   appeared without any transition.
7. **Smaller layout defects.** SQL library empty state sat in a short white box
   above a differently tinted page; the table-transfer label wrapped in
   Traditional Chinese and its close button was centred against two lines; the
   title-bar update light was a solid dot even when nothing needed attention;
   repeated "Edit" buttons dominated the table-design grid; the sidebar search
   placeholder was truncated.

## Decisions

### Operation notices

`statusText` remains the single status channel and the screen-reader live
region. `useConnection` journals every write (with the explicit error flag from
`setStatus`), and the orchestrator drains the journal after each task:

- `utils/statusMessages.js` classifies the zh-CN source messages into quiet,
  info, success, warning or error, and maps common templates to `status.*`
  catalog keys. Unmatched messages keep their text; English adds a localized
  generic heading.
- `operationNotices.js` owns timing (errors 9s, warnings 5.6s, success 3.2s),
  hover/focus pause, a three-notice limit, same-event coalescing (a short
  feedback title absorbs the detailed status written with it, e.g. an export
  path), and suppression of messages already shown beside a cell.
- `OperationNoticeStack.vue` renders bottom-right, below menus and dialogs,
  never taking layout space. Progress chatter ("opened table", "loading") stays
  quiet.

### Lists and grid

- Home rows: full-row hover/selection (`--wb-list-*` tokens), aligned headers
  with hover-only grips and vector sort arrows, end-aligned sizes, stars on
  hover/selection/favorite, a fill comment column that fits the pane when its
  width is automatic, and row-wide Ctrl/Shift selection. This supersedes the
  July name-only selection, matching the July refinement plan.
- Grid header: vector chevron/arrow sort trigger revealed with its header, a
  solid arrow on the sorted column, a fixed sort-menu shadow with icons, and an
  icon toggle for the comments row.
- Inspector: two compact lines per field with type-family icons
  (`columnTypeKind`), and guidance instead of an empty panel.

### Motion and tokens

Shared `--wb-duration-*`, `--wb-ease-*` and `--wb-list-*` tokens. Dialogs,
overlays and context menus ease in (120–180ms) using the individual
`translate`/`scale` properties so inline positioning transforms (draggable
batch import) are untouched; closing stays instant. Everything is disabled
under `prefers-reduced-motion`.

### Localization

New strings use named keys; strings guarded by source-contract tests use the
legacy `m_` + sha256(zh-CN)[:12] convention so `localizedContractSource` keeps
expanding them.

## Verification

- `node scripts/test-workbench.mjs`: 2003 of 2004 pass; the one failure
  (activity rail favorites `emit('select', item.id, $event)` contract) predates
  this work.
- Browser: `test-grid-columns`, `test-grid-insert-drag`, the table-transfer
  smoke flow, and `test-language-browser` (its settings selector was updated to
  the activity rail, which had replaced the old sidebar trigger).
- `npm run quality:duplication`: 2.83% (threshold 5%); no clones in new files.
- Production `vite build` succeeds.

## Follow-ups

- Localize the remaining dynamic status messages at their call sites and let
  the live region announce the localized text.
- `scripts/verify-canvas-surfaces.mjs` still targets the removed sidebar
  settings trigger.
- After a box selection, Shift+click starts a new range because the box does
  not set the selection anchor.

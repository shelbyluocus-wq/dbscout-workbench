# Table Design Editor Polish Design

**Status:** Approved on 2026-06-06

## Goal

Make the MySQL table design editor (`TableDesignEditor.vue`) feel closer to a
modern schema workbench — readable in light mode, flexible in layout, helpful
when typing field metadata, and pleasant to reorganize. The change touches
only the table design surface; it does not alter data contracts, the table
session editor, or backend behavior.

The seven pain points driving this design:

1. Light-theme borders are too pale — table cells, input frames, and checkbox
   outlines almost disappear against the surface.
2. Column widths are hard-coded with `min-width: 98px`; users cannot widen
   "name" or "comment" to read long values.
3. The "type" column is a free-text input; users must remember the exact casing
   of `VARCHAR` and `DECIMAL` and then re-enter the length manually.
4. New fields default to `nullable = false`, forcing an extra click on every
   row the user adds.
5. There is no way to reorder fields; the design grid reflects physical column
   order only, which makes it hard to cluster related fields visually.
6. The "primary key" column sits awkwardly between "nullable" and "default
   mode" in the header, requiring eye-jumps when scanning a row.
7. The "comment" field is a one-line `<input>` with no markdown affordance, so
   field documentation ends up as a wall of plain text in the inspector.

## Chosen Direction

A focused polish, not a rewrite. The editor stays a grid; we layer
interactivity on top.

- Keep the existing row-based layout. We add a drag handle to each row and
  a column-resize handle in the header, but rows still render as
  `display: grid` items.
- Reorder the header columns to put "primary key" in the second slot,
  matching user scanning habits (name → pk → type → length → …).
- Promote the type cell from a plain input to a `<select>` with a curated
  type list, but keep free typing as a fallback (so existing schemas with
  unusual types still load).
- Introduce a new semantic border token (`--wb-border-medium`) for the
  design grid in light mode; do not blanket-bump all borders, because the
  sidebar tree, status bar, and grid cells deliberately use weaker lines.
- Use a lightweight, focused dependency footprint: `vuedraggable@4` for
  row reordering and `marked@12` for markdown rendering. Both are small,
  stable, and have no transitive concerns for the Tauri build.

## Out Of Scope

- Changing how `useTableDesign.js` builds the SQL payload or what fields it
  sends to the backend.
- Persisting a user's row order to the database. Drag-to-reorder updates the
  in-memory `draft.columns` only; applying the design still emits columns in
  their reordered order, which is the natural interpretation.
- Adding new types beyond the curated list. Users who need exotic types
  (e.g. `GEOMETRY`, `ENUM('a','b')`) can still type them manually.
- Migrating away from the existing flat grid to a sticky-headers table. The
  row count for a single table is small (typically < 50), so the simple
  grid is fine.
- Touching the right-hand inspector's comment renderer. This design upgrades
  the comment editor inside the design grid; the inspector continues to
  show the comment as a single line of plain text.

## Architecture

```
TableDesignEditor.vue
├── <table-design-header>            (column headers + resize handles)
├── <draggable v-model="draft.columns" handle=".wb-design-drag-handle">
│     <table-design-row
│        v-for="col in draft.columns"
│        :col="col"
│        @open-comment="openCommentDialog(col)"
│        @type-change="onTypeChange(col, $event)" />
├── <markdown-editor-dialog
│      v-if="commentTarget"
│      v-model="commentTarget.comment"
│      :title="`字段备注 — ${commentTarget.name}`" />
```

The editor keeps its current responsibilities and delegates new behavior
through three small pieces:

- `useResizableColumns(tableName, defaultWidths)` — composable that manages
  a `widths: Ref<number[]>`, persists to `localStorage` under
  `dbscout:designWidths:<tableName>`, and exposes `startResize(index, evt)`.
- `columnTypes.js` — static list of common types with default length/scale
  metadata. Pure data, no Vue coupling, easy to unit-test.
- `MarkdownEditorDialog.vue` — modal dialog with a two-pane editor (textarea
  on the left, rendered preview on the right) and a footer with "清空" /
  "插入示例" / "保存" / "取消" buttons. Closes on `Esc` and on backdrop
  click.

The draggable row relies on `vuedraggable`'s `update` event, which mutates
`draft.columns` in place. The "primary key second" header reordering is a
pure CSS change: the header element for "主键" gets `order: 2` and the
existing cells shift accordingly, while the data row's cell order matches.

## Component & Composable Contracts

### `useResizableColumns(tableName, defaultWidths)`

```js
const { widths, startResize } = useResizableColumns('game_db.db1.audit_0010', [
  160,  // name
  60,   // primary
  100,  // type
  80,   // length
  70,   // scale
  70,   // nullable
  90,   // default mode
  110,  // default value
  220,  // comment
])

// startResize(columnIndex, mousedownEvent)
// - on mousemove: writes widths[index] = clamp(newPx, 40, 480)
// - on mouseup: persists to localStorage
```

Behavior:
- `widths` initializes from `localStorage` if present, else from
  `defaultWidths`.
- The localStorage key is `dbscout:designWidths:<sanitized tableName>`.
  The sanitizer lowercases and replaces non-alphanumeric chars with `_`.
- Writes are debounced 200ms to avoid hammering storage during a drag.
- Returns a `reset()` function that clears storage and re-applies defaults;
  wired to a small "重置列宽" link at the bottom of the grid.

### `columnTypes.js`

```js
export const COMMON_TYPES = [
  { value: 'TINYINT',   defaultLength: null, hasScale: false },
  { value: 'INT',       defaultLength: null, hasScale: false },
  { value: 'BIGINT',    defaultLength: null, hasScale: false },
  { value: 'DECIMAL',   defaultLength: 10,   hasScale: true,  defaultScale: 2 },
  { value: 'CHAR',      defaultLength: 1,    hasScale: false },
  { value: 'VARCHAR',   defaultLength: 255,  hasScale: false },
  { value: 'TEXT',      defaultLength: null, hasScale: false },
  { value: 'MEDIUMTEXT',defaultLength: null, hasScale: false },
  { value: 'DATE',      defaultLength: null, hasScale: false },
  { value: 'DATETIME',  defaultLength: null, hasScale: false },
  { value: 'TIMESTAMP', defaultLength: null, hasScale: false },
  { value: 'JSON',      defaultLength: null, hasScale: false },
]

export function findTypeMeta(value) {
  return COMMON_TYPES.find(t => t.value === value) || null
}
```

`useTableDesign.js` gains an `onTypeChange(column, newType)` helper:

- Looks up the type meta.
- If the user has **not** manually edited `column.length` (tracked by a new
  `column._lengthDirty` boolean), set `length` to the meta default and
  `scale` to `defaultScale` (cleared when not applicable).
- If the user has edited, leave the value alone.
- `addColumn()` is updated to default `nullable: true`. The single primary
  key column created in `createDraft()` keeps `nullable: false` because
  primary keys must be `NOT NULL`.

### `MarkdownEditorDialog.vue`

Props:
- `modelValue: String` — the comment text (v-model).
- `title: String` — dialog title.
- `placeholder: String` (optional).

Emits:
- `update:modelValue` — bubbles textarea changes.
- `close` — fires when user clicks cancel, backdrop, or presses `Esc`.

Internal structure:

- Fixed-width modal (640px wide, 70vh tall) centered with a backdrop.
- Header bar with title and a small "Markdown 语法" hint that toggles a
  one-paragraph cheatsheet popover.
- Body uses CSS Grid: `1fr | 1fr` two columns. Left is a styled `<textarea>`
  with monospace font and line numbers via a gutter div. Right is a
  `v-html`-bound preview that runs `marked.parse()` inside a `computed`.
- Footer: "清空" (clears textarea), "插入示例" (inserts a multi-line
  template showing headings, lists, and code), "保存" (emits update then
  close), "取消" (close without saving).

The `utils/markdown.js` wrapper:

```js
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: false,
  // marked 12 default: mangle: false, headerIds: false
})

export function renderMarkdown(text) {
  if (!text) return ''
  try {
    return marked.parse(text)
  } catch (e) {
    // Fallback to escaped plain text on parser error.
    return escapeHtml(text)
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}
```

The preview's container applies a small `.wb-md-preview` class that styles
headings, code blocks (with a subtle background and monospace font), lists,
and links to match the existing `--wb-*` tokens.

## CSS Token Addition

In `workbench.css`, light theme defaults, add one new token and tweak two
existing ones:

```css
:root {
  /* Existing — bumped slightly for table design grid */
  --wb-border-soft:    #e3e6ec;   /* was: #ebeef2 */
  --wb-border-medium:  #cdd2da;   /* NEW — used in design grid */
  --wb-border-strong:  #aab1bd;   /* was: #b6bcc6, used in header bottom */
}
```

Dark theme values stay as-is because the existing dark borders are already
visible.

Usage rules:

- `.wb-design-grid > .wb-design-row` — `border-bottom: 1px solid var(--wb-border-medium)`.
- `.wb-design-header` — `border-bottom: 1px solid var(--wb-border-strong)`.
- `.wb-design-cell input[type="text"]`, `select` —
  `border: 1px solid var(--wb-border-medium)` at rest, `var(--wb-accent)`
  on focus.
- `.wb-design-check-cell input[type="checkbox"]` — accent color stroke at
  rest (already provided by `--wb-accent`).

## Data Flow

```
User action                Composable / Helper                State change
─────────────────────────────────────────────────────────────────────────
Add field                  useTableDesign.addColumn()         draft.columns.push({nullable:true,...})
Edit type                  onTypeChange(col, newType)         col.length / col.scale / col._lengthDirty
Edit length                @input on length input             col._lengthDirty = true
Drag row                   vuedraggable onUpdate              draft.columns reordered
Resize column              useResizableColumns.startResize    widths[i] updated, debounced LS write
Open comment dialog        @click on comment cell             commentTarget = col
Edit comment in dialog     <textarea> v-model                 col.comment (live two-way)
Save dialog                <markdown-editor-dialog>           emits update:modelValue, closes
```

`buildPayload()` in `utils/tableDesign.js` does not need to change: the
column reorder is reflected in `draft.columns` order, length/scale filters
by type, and `_lengthDirty` is an internal flag the payload helper can
ignore.

## Error Handling

| Scenario                                  | Behavior                                                      |
|-------------------------------------------|---------------------------------------------------------------|
| `marked.parse` throws on malformed input  | `renderMarkdown` catches and returns escaped plain text.      |
| localStorage write fails (quota / private)| Resize still works for the session; warning toast on first    |
|                                           | failure, no retry storm.                                      |
| User types exotic type into type select   | Select is editable; `findTypeMeta()` returns `null` and the    |
|                                           | length auto-fill is skipped.                                  |
| Drag places a primary key row in position | No automatic re-validation here. The existing "primary key   |
| N where N already has a primary key       | uniqueness" guard in `useTableDesign.js` still runs on save.  |
| User resizes column beyond viewport       | `clamp(value, 40, 480)` prevents tiny or huge widths.         |
| Markdown preview XSS                      | `marked` does not execute scripts; combined with the static   |
|                                           | template (no `v-html` on user-typed URLs we don't sanitize)   |
|                                           | the attack surface is the same as any markdown renderer.      |

## Testing Strategy

- **Unit tests (node:test):**
  - `columnTypes.test.js` — `findTypeMeta` returns expected meta for
    curated and unknown types.
  - `useResizableColumns` test (jsdom optional) — width clamp, debounce,
    localStorage round-trip with a fake storage object.
  - `markdown.test.js` — `renderMarkdown` returns escaped string on
    injected `throw`, normal string on headings/lists/code.

- **Manual visual checks (light + dark theme):**
  - Border visibility in light mode at 100% / 110% browser zoom.
  - Resize a column to 480px then back to 40px, refresh page, confirm
    persistence.
  - Drag the first row below the last row, save the design, re-open, and
    confirm order sticks for the session.
  - Type a markdown comment with a code block, save, re-open the dialog,
    confirm preview still renders.

- **Regression checks:**
  - Existing `node --test` suite still passes (no removed exports).
  - Right-hand inspector still shows the first 60 chars of the comment.

## Risks

- **`vuedraggable@4` with Vue 3** — pin to `4.1.0`, which is the current
  release line. If a runtime mismatch surfaces, fall back to
  `vue-draggable-plus` (drop-in API), at the cost of a slightly larger
  bundle. Mitigation noted in the implementation plan, not the spec.
- **marked output and Vue's `v-html`** — by design we trust the user's
  own typed comment. The inspector already shows the comment as plain
  text; the design grid preview is the only place we render HTML, and it
  is local to the modal.
- **CSS Grid column reorder via `order`** — the table's existing layout
  already uses CSS Grid, so reordering cells is one property change. We
  verify visually that resizing the second column still works after the
  reorder.

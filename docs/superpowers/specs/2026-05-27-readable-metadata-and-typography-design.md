# Readable Metadata And Typography Design

**Status:** Approved on 2026-05-27

## Goal

Improve readability across DB Scout Workbench without changing its compact
table-focused workflow. Database navigation, field metadata, remarks, and
supporting status text should be easy to read in both light and dark themes,
while the interface retains the restrained Codex-like appearance already
chosen for the product.

The current problem is structural: one low-emphasis `--wb-muted` color is used
for database nodes, table comments, field types, field comments, row indexes,
empty states, and dialog helper text. Those elements do not carry the same
importance, so they need separate visual semantics instead of one shared faded
gray.

## Chosen Direction

Use a semantic readability refinement rather than a density or layout
redesign:

- Preserve the compact `connection > database > table` navigation tree and
  current three-pane layout.
- Keep the platform-oriented Codex-style UI font stack, tuned for Windows and
  Chinese legibility with `Segoe UI Variable`, `Segoe UI`, `Microsoft YaHei UI`,
  `Microsoft YaHei`, and equivalent fallbacks.
- Add semantic theme tokens for identifiers, metadata/type text, descriptive
  remarks, and truly quiet auxiliary text.
- Keep table cell data and primary actions neutral; colored metadata is used
  only where it improves scanning, not as decoration.
- Adjust both light and dark token values together so the dark theme is not a
  dimmer copy of the light theme.

## Readability Audit Scope

The redesign applies to all currently visible text roles that rely on weak
secondary styling:

- Left navigation: database names, table names, table comments, search
  placeholder, and no-results text.
- Tabs and bottom status bar: database source text, table comment, row count,
  and selected-cell identity labels.
- Center table: toolbar helper controls, grid headings, row indexes, loading
  and empty states, and `NULL`/placeholder treatment.
- Right inspector: pane source title, field name, field type, primary-key
  status, field remark, and the selected-text editor header.
- Dialog and import helper text where shared semantic tokens currently make
  instructions unnecessarily faint.

This is a style and presentation change. It does not add object types, alter
table browsing behavior, change persisted theme preference, or modify backend
schema/data contracts.

## Semantic Text System

Introduce role-specific CSS tokens within the existing `--wb-*` theme system:

- Primary identifiers: table names, field names, active source names, and
  meaningful empty-state prompts use the existing primary text color or a
  dedicated identifier token close to it.
- Metadata/type: SQL types and compact source metadata use a calm cool-blue
  token. This distinguishes machine structure from prose without becoming a
  saturated accent.
- Remarks/descriptions: table and field remarks use a stronger neutral
  secondary token, readable as text rather than treated as disabled UI.
- Quiet/supporting text: placeholders, passive hints, row numbers, inactive
  controls, and minor labels use the quieter token only where low emphasis is
  intentional.
- Selected/active state: the existing teal accent remains the interaction
  signal; it is not reused as the default remark color.

The type and remark tokens must remain visibly distinct from one another in
both themes. Remarks must remain readable at small sizes and should not be
reduced below the inspector's current practical density.

## Inspector Presentation

Keep each field as a compact three-part metadata record:

```text
field_name
VARCHAR(120) · 主键
用户可读的字段备注
```

- Field names are the strongest text within each row.
- SQL types use the metadata/type color with tabular-friendly compact
  treatment.
- The primary-key indicator uses the existing accent semantics, presented as a
  compact tag or emphasized fragment instead of blending into type text.
- Field remarks use the descriptive remark color and a slightly more readable
  line height.
- The currently selected cell's field receives a subtle active row treatment
  so the metadata panel and the grid communicate the same focus.
- Fields with no remark do not render a misleading empty low-contrast line.

The inspector keeps its current scrolling and editor behavior. It does not
become an editable schema view.

## Navigation And Workspace Presentation

- Database nodes should be readable secondary identifiers rather than faded
  hints, while selected nodes retain accent emphasis.
- Table comments remain single-line to protect navigation density, but adopt
  the descriptive remark color and a readable minimum size.
- Tab source/database labels and the bottom table comment use the same
  descriptive/metadata roles as the navigation tree so repeated information
  feels consistent.
- Grid headings become slightly more distinct from row content; row indexes
  and `NULL` values remain intentionally subdued but must not look disabled to
  the point of illegibility.
- Empty states, loading messages, and dialog instructions use readable
  secondary text because they communicate required next actions.

## Component Boundary

The change should stay presentation-focused:

- `src/workbench/components/InspectorPanel.vue` may expose semantic classes for
  field name, field type, key badge, and remark, and relate a field row to the
  currently selected grid column.
- Existing navigation, tab, grid, dialog, and status markup should only gain
  targeted classes if necessary for correct semantic styling.
- `src/workbench/workbench.css` owns typography, theme token values, surfaces,
  text roles, and active treatments.
- Existing shell tests should be extended to require the semantic inspector
  structure and readability tokens; no backend or state tests are needed
  unless an implementation changes non-visual behavior.

## Verification

After implementation:

- Run `node --test src/workbench` to include nested workbench test files on every supported shell.
- Run `npm run build`.
- Open the local UI with demo data and inspect both light and dark themes.
- Verify field name/type/remark separation, primary-key visibility, readable
  database/table/status remarks, toolbar and empty/loading readability, and no
  loss of compact sidebar or grid behavior.

## Out Of Scope

- Adding schema editing, column filtering, or new inspector interactions.
- Introducing extra sidebar object categories or widening the tree by default.
- Changing virtual-grid, session, persistence, Rust, or mock-backend logic.
- Replacing the existing teal interaction accent with a decorative multicolor
  theme.

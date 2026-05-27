# Inspector Readability And Detail Resize Design

**Status:** Approved on 2026-05-27

## Goal

Improve readability for the compact database browser and the inspector while
adding direct control over the space used by the selected-cell detail editor.
This is a focused UI refinement: the existing table-first tree, three-pane
workspace, and data editing behavior stay unchanged.

## Chosen Direction

- Raise the contrast of inactive database labels independently from lower-value
  helper text, so source names remain readable without competing with the
  selected database accent.
- Increase inspector field remark text size and line height while preserving the
  visual hierarchy between field name, SQL type, key badge, and prose remark.
- Place a horizontal resize handle between the inspector's schema/remark list
  and the selected-cell detail editor.
- Allow dragging the handle vertically within sensible minimum heights and
  allow double-clicking it to restore the default editor height.
- Keep the adjusted height in current component state only. Persisting personal
  layout preferences is outside this small readability request.

## Interaction Design

The right pane remains one inspector. Its upper list continues to scroll for
columns and field remarks, and its lower detail editor continues to show or
edit the selected cell value.

The new divider appears immediately above the lower detail section:

```text
Field remarks list
------------------  drag vertically; double-click to reset
Selected field title
Detail editor
```

Dragging upward gives the detail editor more height; dragging downward gives
the field list more height. The list and editor each retain a minimum usable
height so neither section can disappear. The handle exposes a row-resize
cursor and an accessible separator role.

## Implementation Boundary

- `src/workbench/components/InspectorPanel.vue` owns the local divider event
  wiring and applies a computed height to the detail section.
- `src/workbench/composables/useInspectorResize.js` owns height defaults,
  clamping, drag state, cleanup, and reset behavior.
- `src/workbench/workbench.css` owns label contrast, remark typography, and the
  visual/interaction styling for the new horizontal handle.
- `src/workbench/workbenchShell.test.js` and a focused composable unit test
  encode the new structural and resize contracts.

No backend, schema, persistence, connection, or grid session logic changes are
required.

## Error And Edge Handling

- The resize composable clamps movement against the available inspector height
  and fixed header/list minimums.
- Mouse release always clears cursor and selection overrides.
- Resizing has no dependency on an active selected cell; an empty editor remains
  resizable and ready for the next selection.
- If the pane height is temporarily unavailable, the default height is kept
  rather than introducing an invalid style.

## Verification

- Run the focused inspector resize and shell contract tests first.
- Run all frontend tests with `node --test src/workbench`.
- Run `npm run build`.
- Open the local demo UI and validate database label contrast, enlarged remarks,
  vertical dragging, and double-click reset in both themes.

## Scope Note

A future layout preference feature could persist the detail-panel height, but
that would introduce settings/state behavior beyond this request. The current
design intentionally stops at a predictable in-session adjustment.

# Homepage Selection Dismissal Design

## Goal

Clear the homepage table selection when the user clicks somewhere else, while preserving selection long enough for selection-based actions and preventing a completed box selection from clearing itself.

## Interaction Contract

- Clicking a table-name button in the same homepage keeps the current selection behavior. The existing single-select and modifier-key selection rules remain unchanged.
- Clicking a table comment, field count, list blank area, homepage toolbar, tab bar, sidebar, inspector, or another page clears the homepage selection.
- Clicking an action that consumes the selection runs that action first, then clears the selection.
- Completing a valid box selection does not clear the new selection when the browser emits the follow-up click event.
- A click without a valid box drag clears the previous selection.
- Each mounted homepage owns its own selection. Clicking inside another homepage clears this homepage unless the normal action flow already replaced its selection.

## Approaches Considered

### Recommended: document click listener owned by each homepage

Each `DatabaseHome` instance listens for document-level clicks in the capture phase while mounted. It preserves clicks on its own table-name buttons, ignores the single follow-up click after a valid box selection, and schedules its controller selection to clear after every other click finishes propagating. Deferring the clear lets selection-based buttons and teleported context-menu items finish their normal action even when they stop click propagation.

This is the smallest approach that covers clicks outside the homepage without adding workbench-wide selection knowledge.

### Alternative: workbench-level selection coordinator

The workbench shell could clear homepage state from a global pointer handler. This centralizes dismissal but couples the shell to homepage-specific DOM and selection rules, and it would need extra exclusions for selection-based actions.

### Alternative: list-only blank click handling

The current list can clear selection on its own blank areas. This is simpler but does not satisfy clicks on tabs, the sidebar, toolbar, inspector, or other pages.

## Component Responsibilities

- `DatabaseTableList` reports when a valid box selection has finished so the homepage can suppress the browser's immediate follow-up click.
- `DatabaseHome` owns document listener registration, target classification, suppression of one post-box-selection click, and schedules the existing selection controller to clear after the current click finishes.
- The workbench shell and persisted homepage tab state continue receiving selection updates through the existing state synchronization path.

## Lifecycle And Edge Cases

- Register the document listener on mount and remove it before unmount to avoid duplicate handlers and leaks.
- Do not clear selection during an in-progress rename interaction before its normal submit or cancel handling completes.
- The suppression flag is one-shot and is consumed only by the click that follows a valid box selection.
- Keyboard selection and keyboard actions are unchanged.

## Testing

- Add a failing interaction contract test for document listener lifecycle, own-table-name preservation, and outside-click clearing.
- Add a failing contract test for the valid-box-selection suppression signal.
- Run the homepage interaction tests, focused workspace persistence tests, the affected shell contract, and the production build.
- Manually verify selection dismissal from the homepage, tab bar, and sidebar in the browser.

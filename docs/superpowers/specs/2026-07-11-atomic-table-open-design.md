# Atomic Table Opening Design

## Problem

Opening a new table currently exposes the new tab before its first page is
ready. The existing table remains visible until the request finishes, so the
tab strip and content pane temporarily describe different active objects.
This is perceived as lag even when the request itself is progressing normally.

## Decision

Treat a new table open as a two-phase operation:

1. Prepare the table session and first page in the background while the current
   table remains visible and usable.
2. Once the first page is ready, publish the new tab and activate its content in
   the same Vue update cycle.

The pointer uses the platform `progress` cursor while any table open is pending.
This communicates background work without implying that the entire workbench is
blocked.

## Alternatives Considered

### Activate immediately and show a loading grid

This would synchronize the selected tab and content pane immediately, but it
would replace useful content with an incomplete loading state. It does not meet
the requirement that the destination table appear complete when selected.

### Keep the current delayed activation and decorate the pending tab

This would explain the delay but preserve the mismatch between the visible tab
and the active content. It treats the symptom rather than the state transition.

### Publish and activate atomically after loading (selected)

This keeps the current workspace useful during the request and guarantees that
the new tab and its populated grid appear together. The progress cursor supplies
immediate acknowledgement during slow database responses.

## State And Data Flow

- A newly created table tab is marked as opening and remains excluded from the
  rendered tab strip until its first page has been applied.
- The existing active tab and pane remain unchanged during this phase.
- The opening request is tracked per tab so repeated clicks reuse the same
  in-flight operation rather than exposing an empty tab or opening duplicate
  backend sessions.
- On success, the first page is applied, the opening marker is cleared, and the
  target tab is activated synchronously. Vue batches these mutations into one
  render, so the label, selected state, and complete grid appear together.
- A small counter, rather than a single boolean, drives the progress cursor so
  overlapping table opens cannot clear the indicator prematurely.
- Existing, already-loaded tabs continue to activate immediately.
- Opens requested with activation disabled, such as workspace restoration,
  load normally without changing the focused pane.

## Failure And Cancellation

- If the first page fails, the provisional tab is removed and the current table
  remains active. The existing status/error channel reports the failure.
- If a provisional tab disappears before the backend responds, any returned
  session is closed using the existing session ownership safeguards.
- Completion of one request does not clear the progress cursor while another
  table is still opening.

## Visual Behavior

- No loading overlay, skeleton, or empty grid is introduced for a normal new
  table open.
- The application root receives an opening-state class that applies
  `cursor: progress` to the workbench during background preparation.
- The cursor state is available in both light and dark themes and requires no
  animation, so reduced-motion behavior is unchanged.

## Tests

Focused tests will cover:

- A pending new tab is not visible or active while its first page is unresolved.
- The tab becomes visible and active only after rows and columns are applied.
- The current tab remains active throughout the pending period.
- Repeated opens of the same pending table reuse one request.
- A failed open removes the provisional tab and preserves the current tab.
- Overlapping opens keep the progress state active until all requests finish.
- Existing-tab activation and non-activating workspace restoration keep their
  current behavior.

Manual verification will use a delayed mock response to confirm that the pointer
changes immediately and the populated tab and grid appear together without a
blank intermediate frame.

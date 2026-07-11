# Table Open Navigation Safety Design

## Problem

The atomic table-opening flow keeps a new table provisional until its first
page is ready, but the provisional request currently owns an activation intent
that is cancelled only when the user clicks an existing tab. Other navigation
paths can therefore be overwritten by a slower table request. Provisional tabs
also remain in pane state, so keyboard tab cycling can activate a tab that the
tab strip intentionally hides.

These gaps can recreate the original user-visible mismatch: the selected
database, visible tab strip, and rendered table content can describe different
objects.

## Decision

Keep provisional tabs in workspace state for request reuse and session
ownership, but centralize the rules that prevent them from becoming visible or
active prematurely.

1. `useTableSession` observes synchronous workspace navigation changes. A
   change to the active tab, focused pane, connection, or database invalidates
   pending table activation intents before a slow request can publish focus.
2. A shared workspace helper defines whether a tab is published. Pane
   rendering, active-content selection, and keyboard cycling use that same
   definition instead of independently filtering tabs.
3. Table-open completion may publish and activate a tab only while its original
   activation intent remains current. Loaded tabs with stale intent remain
   available but do not steal focus.
4. The workbench root exposes background progress without forcing a progress
   cursor on interactive descendants.

## Alternatives Considered

### Cancel at every navigation call site

This is the smallest patch, but the workbench has many activation paths. The
current bug exists because one call site was protected while others were
missed, so repeating that pattern is not sufficiently robust.

### Central navigation invalidation and published-tab filtering (selected)

This preserves the existing provisional-tab lifecycle while enforcing its
invariants at shared boundaries. It is focused enough for the current bug and
does not require rewriting session ownership.

### Keep provisional tabs outside workspace state

This creates the strongest separation, but it would require new duplicate
detection, pane ownership, cancellation, and session cleanup infrastructure.
That scope is unnecessary for the confirmed failures.

## State And Data Flow

- Starting a new table open creates an `opening` tab without activating it.
- The request records the latest activation intent for its target pane.
- Synchronous navigation observation invalidates pending intents when the user
  changes the active tab, pane, connection, or database.
- Successful loading applies columns and rows, clears `opening`, and activates
  only if the intent is still current.
- Published-tab consumers exclude `opening` tabs. Keyboard cycling cannot
  target them, and pane content cannot render one as active even if another
  state path accidentally assigns its ID.
- Failed loading removes the provisional tab and preserves the current view.

## Error And Concurrency Handling

- Repeated clicks continue to reuse one in-flight request.
- Overlapping opens retain last-intent-wins behavior within a pane.
- Switching databases or returning to the homepage prevents older requests
  from stealing focus after completion.
- Explicit tab selection and keyboard cycling both invalidate older activation
  intent through the same navigation observation.
- A stale loaded table remains a normal background tab after its data is ready;
  it is not discarded merely because the user navigated elsewhere.

## Visual Behavior

- The current table or homepage remains visible while another table loads.
- No hidden provisional tab can be selected by mouse or keyboard.
- The root workbench may show the platform progress cursor over neutral
  background areas, while buttons, inputs, resize handles, and other usable
  controls retain their normal cursors.

## Tests

Automated regression coverage will verify:

- switching to another database homepage invalidates an older table activation;
- keyboard cycling skips provisional tabs;
- pane active-content resolution rejects provisional tabs;
- successful table loading still publishes and activates when navigation has
  not changed;
- repeated and overlapping opens preserve existing behavior;
- the progress cursor rule no longer overrides every descendant;
- focused table-session, workspace-state, shell-contract, and persistence tests
  remain green.


# Table Search Behavior Restoration Design

## Problem

The performance search path changed in-table search from navigation over the
ordinary table into a temporary hit-only result table. Each query also sets the
main grid loading state and exposes partial counts until more result pages are
requested. This causes flashing, hides non-matching rows, and makes a completed
search require further navigation.

## Selected Approach

Restore the pre-optimization in-table search behavior while retaining the
indexed row store, incremental local match cache, cancellable request guards,
and backend search-job infrastructure for other search surfaces.

For normal table search:

- keep the ordinary table row store mounted;
- search loaded rows locally and automatically load remaining ordinary pages;
- continue until the table is fully loaded or the query becomes stale;
- publish the complete hit count only after the automatic scan finishes;
- use previous/next only for navigation, never to continue the scan;
- clearing the query only clears search state and restores the saved selection.

The hit-only result mode remains available only to workflows that explicitly
open a hit-result table. Typing in the normal table search box must never enter
that mode.

## User Experience

The grid remains visible and stable while searching. Non-matching rows stay in
place. Search automatically reaches the final result set without user action,
then the arrows wrap through the complete set of matching cells.

## Verification

Regression tests must prove that normal search does not call the hit-result
loader, automatically loads all remaining ordinary pages, does not expose a
partial final count, keeps ordinary rows, supports rapid-query cancellation,
and clears without refetching the table.

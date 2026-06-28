# Grid Performance Optimization Design

## Goal

Make DB Scout Workbench feel substantially faster when opening tables, scrolling large grids, searching within a table, and searching values across the sidebar, while removing code that is provably obsolete. The first implementation wave must prioritize real user-perceived latency: first usable grid frame, scroll smoothness, search responsiveness, and avoiding work that does not affect the visible result.

## Current Hotspots

The current code has several high-impact bottlenecks:

- `src-tauri/src/db.rs::read_db_page` and `src-tauri/src/clickhouse.rs::read_page` run a blocking count query before returning page rows. On large real tables, this makes the first table frame wait for `COUNT(*)`.
- `src/workbench/composables/useTableSearch.js::findSearchMatches` rescans all loaded rows and all columns every time table search refreshes. It also uses fuzzy matching, including edit-distance and subsequence checks, so cost grows with loaded row count and cell text size.
- `src/workbench/components/DataGrid.vue` repeatedly calls `columnName`, `buildRowKey`, `highlightCell`, `isCellPending`, and `getCellError` while rendering visible cells. The grid is virtualized vertically, but visible cell work is still high for wide tables and highlighted searches.
- `src/workbench/composables/useVirtualGrid.js` emits a new virtual row array on scroll and recomputes row keys synchronously in the scroll-driven render path.
- Infinite load is triggered directly from grid scroll proximity in `WorkbenchPane.vue` and `MySqlWorkbench.vue`. The guard prevents duplicate backend calls, but the event path still mixes scroll handling with network decisions.
- The legacy frontend `useDataSearch.js` and mock/backend `search_data` compatibility path are no longer part of the current UI flow, which now uses `search_values`. They should be removed only after static tests and command registration prove no live caller remains.

## Design Principles

- First frame before completeness: table rows and columns should render before exact total counts or full-match search state are available.
- Do less work per visible cell: normalize columns, row keys, error/pending state, and highlight HTML once per visible slice where possible.
- Make search incremental: cache scan progress for a query signature and avoid rescanning unchanged rows.
- Preserve correctness around editing, inserts, row identity, sorting, filtering, split panes, and export.
- Keep backend contracts explicit. When row counts are approximate or unknown, the payload must say so rather than overloading `0`.
- Delete code only after proving it has no production caller or after replacing callers in the same patch.

## Backend Paging

Add lightweight pagination metadata to `TableSessionPage`:

- `total_rows`: remains for compatibility and contains the best known count.
- `total_rows_exact`: new boolean. `true` means `total_rows` is exact. `false` means it is a lower-bound or unknown estimate.
- `has_more`: new boolean. It is computed from `rows.len() == page_size` when no exact count is available, and from exact count when available.

For MySQL and ClickHouse page reads:

- Default interactive table reads skip `COUNT(*)`.
- A page request may opt into exact counts with a new `include_total` flag.
- Open table and infinite-scroll requests use `include_total: false`.
- Explicit refresh/filter/sort requests do not block the first grid frame on exact counts. Exact counts are requested only through an explicit follow-up path or an explicit user-visible command.

The UI should display:

- exact counts as before when `total_rows_exact === true`;
- loaded-row progress such as "loaded 1000+" when exact count is unknown and `has_more` is true;
- "loaded all N rows" when `has_more` is false.

This removes the worst first-open database penalty without weakening row data correctness.

## Frontend Table Session

`useTableSession` should stop deriving next page solely from `REQUEST_PAGE_SIZE`. Instead, derive it from the effective page size returned by the backend:

- `nextPage = Math.floor(tab.rows.length / tab.pageSize) + 1`.
- Stop loading when `tab.hasMore === false`, or when an appended page returns no rows.
- Preserve stale request guards.
- Keep sort and filter refresh behavior compatible with existing tests.

The workspace tab state should store:

- `totalRowsExact`
- `hasMore`
- `rowKeyCacheVersion`, incremented when rows or primary-key metadata are replaced, so any row-key cache has a deterministic invalidation source.

`replaceTabPage` and `appendTabPage` become the single normalization boundary for these fields.

## Search Acceleration

Introduce a dedicated table search cache in `useTableSearch`:

- Query signature: tab id, table key, filter text, filter mode, column names, row count, and an edit-state mutation counter added to `editState`.
- Scan state: next row index to scan, ordered matches, best known match count, and whether the loaded slice is fully scanned.
- Incremental scanning: scan in chunks, yielding to the event loop after a small time budget so typing and scrolling stay responsive.
- Navigation uses the existing match list first; if the requested next match is not found and the table may have more rows, load another page and continue scanning only new rows.

Ranking remains compatible:

- exact, prefix, contains, similar, subsequence order stays the same.
- Tests must cover that continuous fuzzy matches still beat subsequence matches.

Highlighting should use a cell-level cache keyed by query signature, row key, column, and raw display value. Visible cells should not recompute expensive fuzzy matching twice just to answer "is this a match" and then render highlighted HTML.

## Grid Rendering

Add a visible-row preparation layer in `useVirtualGrid` or a nearby utility:

- Precompute `rowKey` once for each visible row.
- Precompute normalized column names once per active column set.
- Keep selection state in the existing editor/composable path. Do not introduce broad `visibleCellMeta` until the repeated row-key, column-name, and search-highlight work has been removed.

In `DataGrid.vue`:

- Avoid calling `columnName(column)` repeatedly inside the same cell bindings.
- Avoid calling `highlightCell()` twice for match class and HTML. It should return `{ html, matched }` or use a cached lookup.
- Keep insert-row behavior correct; insert drafts are usually few, so optimize the normal data-row path first.
- Keep manual column resize and auto-fit behavior intact.

Scroll handling:

- Use passive scroll listeners for the grid scroll event.
- Move load-more proximity checks into a requestAnimationFrame-scheduled helper so the scroll event only updates virtual coordinates immediately.
- Keep loading guard semantics in `loadNextPage`.

## Sidebar Value Search

Keep `search_values` as the value-search command, but improve behavior in later waves:

- Use schema prefetch already present in `read_schemas_for_tables`.
- Prefer priority tables first, as current code does.
- Stop scanning as soon as the result limit is reached.
- Consider bounded concurrency for per-table search after the paging/search/grid work is stable. MySQL pool size and server load need tests before parallelizing aggressively.

This design does not make cross-table value search parallel in the first wave because table opening and in-table search are higher-impact for daily interaction.

## Dead Code Removal

Remove only code that is proven unused in the current app:

- `src/workbench/composables/useDataSearch.js` if no imports remain.
- Frontend `search_data` mock handling and tests after confirming no production caller.
- Tauri `quick_search` only if the command is not registered for agent or UI use. If it remains registered, do not remove it in the first wave.
- Rust `#[allow(dead_code)]` value-search helper functions only after replacing tests and all call sites with active helpers.

Dead-code deletion must happen in its own task after performance behavior tests pass, so cleanup does not mask regressions.

## Testing

Add or update tests for:

- Backend page reads can skip exact counts and report `has_more`.
- Exact count opt-in still works.
- Frontend page replacement and append normalize `totalRowsExact` and `hasMore`.
- `loadNextPage` derives next page from returned `tab.pageSize`.
- Incremental table search avoids rescanning unchanged loaded rows for the same query.
- Search result order remains exact/prefix/contains/similar/subsequence.
- Grid visible preparation computes row keys and column names once per slice.
- Legacy `search_data` path is removed only when static tests show no live callers.

Verification commands:

- Enumerate JS tests explicitly or use `node --test src/workbench` only if the current checkout supports it without PowerShell glob issues.
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run build`
- Live dev smoke with stress demo: open a large table, scroll, search, and inspect `[dbscout:perf]` records.

## Implementation Waves

Wave 1: first-frame and infinite-scroll latency.

- Add count-skip metadata and exact-count opt-in.
- Update frontend tab state for unknown totals.
- Adjust status labels and loading stop conditions.

Wave 2: in-table search responsiveness.

- Add incremental search cache.
- Add highlight result caching.
- Preserve navigation behavior and tests.

Wave 3: grid render path.

- Precompute visible row and column metadata.
- Remove duplicate highlighting and normalization calls.
- Throttle scroll-triggered load checks.

Wave 4: cleanup and second-order search work.

- Remove confirmed unused `search_data` / `useDataSearch` code.
- Consider bounded backend value-search concurrency with pool-aware tests.

## Acceptance Criteria

- Opening a large MySQL table no longer waits for a blocking count query before the first rows can render.
- Scrolling a large loaded table keeps work proportional to visible rows and columns, not all loaded rows.
- Repeating next/previous table-search navigation does not rescan unchanged rows from the beginning.
- Typing a table-search query remains responsive while scanning loaded rows.
- Infinite scroll loads more rows without causing scroll-event jank.
- Removed code has no production imports, command registrations, or test-only false positives left behind.
- Automated JS, Rust, and build verification pass.
- Runtime smoke records improved first-frame and scroll/search behavior in the stress demo or a real database when available.

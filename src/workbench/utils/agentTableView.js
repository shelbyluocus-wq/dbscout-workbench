// Applies an open_table view-state payload (filter/filterMode/sort) to a tab
// that is already open. The whole-table filter goes through
// loadSearchResultPage — the same path the toolbar filter box uses — so the
// backend actually receives the query (hitResultMode/searchResultMode is what
// makes usesBackendFilter ship the filter); a plain tab.filter write only
// changes display fields. An explicit "" filter clears the search view and
// restores the normal one. Sort goes through applySort after the filter so it
// refetches inside whatever view the filter step left behind.
import { tabRowCount } from "../rowStore.js";

const SEARCH_FILL_MAX_STEPS = 64;

async function runSearchPage(loadSearchResultPage, tab, text) {
  const result = await loadSearchResultPage(tab, text);
  if (result && result.ok === false && !result.stale) {
    throw new Error(String(result?.error?.message || result?.error || "筛选失败"));
  }
  return result;
}

// A search job only scans one window per call. When the first window contains
// no matches (e.g. a sorted scan whose hits sit at the tail) the grid would
// show "no data" while the status still says the search is running, so keep
// asking for the next window until the first match arrives or the scan ends —
// the same thing the toolbar search's continueUntilFirstMatch does.
async function fillSearchUntilFirstMatch(loadNextSearchResultPage, tab) {
  if (typeof loadNextSearchResultPage !== "function") return;
  for (let step = 0; step < SEARCH_FILL_MAX_STEPS; step += 1) {
    if (!tab.searchResultMode || tab.searchResultComplete === true || tabRowCount(tab) > 0) return;
    const next = await loadNextSearchResultPage(tab);
    if (!next || next.stale) return;
    if (next.ok === false) {
      // The guard return ({ok:false, complete, addedRows:0}) fires when the job
      // already ended or is missing — not an error worth surfacing.
      if (next.error) {
        throw new Error(String(next.error?.message || next.error || "筛选失败"));
      }
      return;
    }
    // A window that scanned rows but matched none (addedRows === 0) is normal —
    // keep going until the first match or the scan completes.
  }
}

export async function applyAgentTableViewState(
  tab,
  viewState = {},
  { loadSearchResultPage, loadNextSearchResultPage, applySort } = {},
) {
  if (typeof viewState.filterMode === "string" && viewState.filterMode) {
    tab.filterMode = viewState.filterMode;
  }
  if (typeof viewState.filter === "string") {
    if (typeof loadSearchResultPage !== "function") {
      throw new Error("missing loadSearchResultPage");
    }
    await runSearchPage(loadSearchResultPage, tab, viewState.filter);
    if (viewState.filter.trim()) {
      await fillSearchUntilFirstMatch(loadNextSearchResultPage, tab);
    }
  }
  const sort = viewState.sort;
  const sortColumn = sort && typeof sort === "object" ? (sort.column || sort.columnName) : "";
  if (sortColumn) {
    if (typeof applySort !== "function") throw new Error("missing applySort");
    const result = await applySort(
      tab,
      sortColumn,
      sort.descending ? "descending" : "ascending",
    );
    if (result && result.ok === false && !result.stale) {
      throw new Error(String(result?.error?.message || result?.error || "排序失败"));
    }
    // applySort refetches inside searchResultMode, which starts a fresh scan
    // window — fill again so a tail-anchored match still reaches the grid.
    if (tab.searchResultMode) {
      await fillSearchUntilFirstMatch(loadNextSearchResultPage, tab);
    }
  }
  return tab;
}

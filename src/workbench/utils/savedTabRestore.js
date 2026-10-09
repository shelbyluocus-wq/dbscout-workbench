import { MAX_FROZEN_COLS, MAX_FROZEN_ROWS } from "../constants.js";
import { reapplyTabColumnOrder } from "../workspaceState.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "./gridRowHeight.js";

/**
 * Whether a saved table/design tab belongs to the source being restored.
 * Snapshots record each tab's connection and database; a tab from another
 * database must not reopen against a same-named table in the current one.
 * Legacy entries without a recorded source fall back to the table-name check.
 */
export function savedTableTabMatchesSource(savedTab, { connectionId = "", database = "", availableTableNames = new Set() } = {}) {
  const tableName = String(savedTab?.tableName || "");
  if (!tableName || !availableTableNames.has(tableName)) return false;
  const savedConnectionId = String(savedTab.connectionId || "");
  const savedDatabase = String(savedTab.database || "");
  if (savedConnectionId && savedConnectionId !== String(connectionId || "")) return false;
  if (savedDatabase && savedDatabase !== String(database || "")) return false;
  return true;
}

/**
 * Apply a saved tab's view state (search, sort, freeze panes, column order,
 * row/comment heights) to a restored tab. Restored data tabs receive this
 * before their first page loads, so the first request already uses the saved
 * sort instead of showing a sort chip over unsorted rows.
 */
export function applySavedTableTabState(tab, savedTab) {
  if (!tab || !savedTab) return tab;
  if (savedTab.filter) tab.filter = savedTab.filter;
  if (savedTab.filterMode) tab.filterMode = savedTab.filterMode;
  if (savedTab.sort) tab.sort = savedTab.sort;
  // Freeze panes: restore per-tab pinned rows/columns (default 0 when absent).
  tab.frozenRowStart = Math.max(0, Math.floor(Number(savedTab.frozenRowStart) || 0));
  tab.frozenRowCount = Math.max(0, Math.min(MAX_FROZEN_ROWS, Number(savedTab.frozenRowCount) || 0));
  tab.frozenColumnCount = Math.max(0, Math.min(MAX_FROZEN_COLS, Number(savedTab.frozenColumnCount) || 0));
  if (Array.isArray(savedTab.columnOrder) && savedTab.columnOrder.length) {
    tab.columnOrder = savedTab.columnOrder;
    reapplyTabColumnOrder(tab);
  }
  tab.fieldCommentsExpanded = savedTab.fieldCommentsExpanded !== false;
  tab.rowHeight = resolveGridRowHeight(savedTab);
  tab.fieldCommentHeight = resolveFieldCommentHeight(savedTab);
  return tab;
}

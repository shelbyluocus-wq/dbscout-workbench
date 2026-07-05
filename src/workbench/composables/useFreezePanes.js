import { GRID_ROW_HEIGHT, ROW_INDEX_WIDTH, MIN_COL_WIDTH, MAX_FROZEN_ROWS, MAX_FROZEN_COLS } from "../constants.js";
import { columnName } from "../utils/normalize.js";

/**
 * Freeze panes (Excel-style frozen rows/columns).
 *
 * State lives on the tab object (`frozenRowCount` / `frozenColumnCount`),
 * mirroring the `sort`/`filter` pattern. This composable centralizes the
 * derived geometry (frozen region heights/widths, sticky offsets) and the
 * mutation helpers so DataGrid / useVirtualGrid / useColumnResize share one
 * source of truth.
 *
 * Freezing is **by position** (like Excel): the top N data rows and leftmost
 * M data columns are pinned. After sort/filter the new top-N / leftmost-M are
 * shown — that's intentional and matches Excel semantics.
 *
 * Frozen rows render separately from the virtualized window (they're always
 * visible), so their height is removed from the scrollable region's
 * `padTop`/`totalHeight` math (handled in useVirtualGrid, which consumes
 * `frozenRowsHeight` from here).
 */

/**
 * @param {object} opts
 * @param {() => number} opts.getColumnWidth – (tabId, colName) => px|undefined
 */
export function useFreezePanes({ getColumnWidth = () => undefined } = {}) {
  function frozenRowCountOf(tab) {
    return Math.max(0, Math.min(MAX_FROZEN_ROWS, Number(tab?.frozenRowCount) || 0));
  }

  function frozenColumnCountOf(tab) {
    return Math.max(0, Math.min(MAX_FROZEN_COLS, Number(tab?.frozenColumnCount) || 0));
  }

  /** Total height (px) of the frozen-row band, sitting just below the header. */
  function frozenRowsHeight(tab) {
    return frozenRowCountOf(tab) * GRID_ROW_HEIGHT;
  }

  /**
   * Width (px) of a single frozen column, falling back to MIN_COL_WIDTH when
   * the column hasn't been auto-fit yet (auto-fit may run after first render).
   */
  function frozenColumnWidth(tab, columnMeta) {
    const name = columnMeta?.name || columnName(columnMeta?.column) || "";
    const w = name ? getColumnWidth(tab?.id, name) : undefined;
    return Number.isFinite(w) && w > 0 ? w : MIN_COL_WIDTH;
  }

  /** Total width (px) of the frozen-column band (excluding the row-index gutter). */
  function frozenColumnsWidth(tab, columns) {
    const count = frozenColumnCountOf(tab);
    if (count <= 0) return 0;
    const metas = Array.isArray(columns) ? columns.slice(0, count) : [];
    return metas.reduce((sum, meta) => sum + frozenColumnWidth(tab, meta), 0);
  }

  /**
   * Sticky `left` offset (px) for the cell at `columnIndex` when it's frozen.
   * Includes the row-index gutter (38px) plus the widths of all frozen columns
   * to the left of this one. Returns 0 for non-frozen columns (caller decides
   * whether to apply sticky).
   */
  function frozenColumnLeftOffset(tab, columns, columnIndex) {
    const count = frozenColumnCountOf(tab);
    if (columnIndex < 0 || columnIndex >= count) return 0;
    let offset = ROW_INDEX_WIDTH;
    for (let i = 0; i < columnIndex && i < count; i++) {
      offset += frozenColumnWidth(tab, columns?.[i]);
    }
    return offset;
  }

  /**
   * Sticky `top` offset (px) for a frozen data row at `rowIndex` (0-based data
   * row index, not visual). Sits below the header.
   */
  function frozenRowTopOffset(tab, rowIndex) {
    return GRID_ROW_HEIGHT + rowIndex * GRID_ROW_HEIGHT; // header + above rows
  }

  function hasFreeze(tab) {
    return frozenRowCountOf(tab) > 0 || frozenColumnCountOf(tab) > 0;
  }

  /** True when this cell sits in the frozen-row × frozen-column corner. */
  function isFrozenCorner(tab, rowIndex, columnIndex) {
    return rowIndex < frozenRowCountOf(tab) && columnIndex < frozenColumnCountOf(tab);
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  function setFreezeRows(tab, count) {
    if (!tab) return;
    const next = Math.max(0, Math.min(MAX_FROZEN_ROWS, Math.floor(Number(count) || 0)));
    tab.frozenRowCount = next;
  }

  function setFreezeColumns(tab, count) {
    if (!tab) return;
    const next = Math.max(0, Math.min(MAX_FROZEN_COLS, Math.floor(Number(count) || 0)));
    tab.frozenColumnCount = next;
  }

  function clearFreeze(tab) {
    if (!tab) return;
    tab.frozenRowCount = 0;
    tab.frozenColumnCount = 0;
  }

  return {
    frozenRowCountOf,
    frozenColumnCountOf,
    frozenRowsHeight,
    frozenColumnsWidth,
    frozenColumnWidth,
    frozenColumnLeftOffset,
    frozenRowTopOffset,
    hasFreeze,
    isFrozenCorner,
    setFreezeRows,
    setFreezeColumns,
    clearFreeze,
  };
}

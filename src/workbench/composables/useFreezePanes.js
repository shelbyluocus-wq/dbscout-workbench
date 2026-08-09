import {
  GRID_FIELD_COMMENT_COLLAPSED_HEIGHT,
  GRID_HEADER_HEIGHT,
  ROW_INDEX_WIDTH,
  MIN_COL_WIDTH,
  MAX_FROZEN_ROWS,
  MAX_FROZEN_COLS,
} from "../constants.js";
import { columnName } from "../utils/normalize.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "../utils/gridRowHeight.js";

/**
 * Freeze panes (Excel-style frozen rows/columns).
 *
 * State lives on the tab object (`frozenRowStart` / `frozenRowCount` /
 * `frozenColumnCount`),
 * mirroring the `sort`/`filter` pattern. This composable centralizes the
 * derived geometry (frozen region heights/widths, sticky offsets) and the
 * mutation helpers so DataGrid / useVirtualGrid / useColumnResize share one
 * source of truth.
 *
 * The row state stores only the visible part of Excel's upper frozen pane.
 * Its end is the selected row boundary; rows before `frozenRowStart` are
 * already above the viewport and do not need sticky DOM nodes. Columns remain
 * left-anchored.
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
  function frozenRowStartOf(tab) {
    return Math.max(0, Math.floor(Number(tab?.frozenRowStart) || 0));
  }

  function maxFrozenRowsForViewport(tab, viewportHeight) {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return MAX_FROZEN_ROWS;
    const availableHeight = Math.max(0, viewportHeight - GRID_HEADER_HEIGHT - fieldCommentBandHeight(tab));
    const visibleRows = Math.floor(availableHeight / resolveGridRowHeight(tab));
    return Math.max(0, Math.min(MAX_FROZEN_ROWS, visibleRows - 1));
  }

  function frozenRowCountOf(tab, viewportHeight) {
    return Math.max(0, Math.min(
      MAX_FROZEN_ROWS,
      maxFrozenRowsForViewport(tab, viewportHeight),
      Number(tab?.frozenRowCount) || 0,
    ));
  }

  function frozenRowRangeOf(tab, totalRows, viewportHeight) {
    const total = Math.max(0, Math.floor(Number(totalRows) || 0));
    const start = Math.min(frozenRowStartOf(tab), total);
    const count = Math.min(frozenRowCountOf(tab, viewportHeight), total - start);
    return { start, count, end: start + count };
  }

  function isFrozenRow(tab, rowIndex, viewportHeight) {
    const start = frozenRowStartOf(tab);
    const count = frozenRowCountOf(tab, viewportHeight);
    return rowIndex >= start && rowIndex < start + count;
  }

  function frozenColumnCountOf(tab) {
    return Math.max(0, Math.min(MAX_FROZEN_COLS, Number(tab?.frozenColumnCount) || 0));
  }

  /** Total height (px) of the frozen-row band, sitting just below the header. */
  function frozenRowsHeight(tab, viewportHeight) {
    return frozenRowCountOf(tab, viewportHeight) * resolveGridRowHeight(tab);
  }

  function fieldCommentBandHeight(tab) {
    return tab?.fieldCommentsExpanded === false
      ? GRID_FIELD_COMMENT_COLLAPSED_HEIGHT
      : resolveFieldCommentHeight(tab);
  }

  /**
   * Width (px) of a single frozen column, falling back to MIN_COL_WIDTH when
   * the column hasn't been auto-fit yet (auto-fit may run after first render).
   */
  function frozenColumnWidth(tab, columnMeta) {
    const name = columnMeta?.name || columnName(columnMeta?.column) || "";
    const callbackWidth = name ? getColumnWidth(tab?.id, name) : undefined;
    const storedWidth = name ? tab?.columnWidthState?.widths?.[name] : undefined;
    const w = Number.isFinite(Number(callbackWidth)) ? Number(callbackWidth) : Number(storedWidth);
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
  function frozenRowTopOffset(tab, frozenIndex) {
    return GRID_HEADER_HEIGHT + fieldCommentBandHeight(tab) + frozenIndex * resolveGridRowHeight(tab);
  }

  function hasFreeze(tab) {
    return frozenRowCountOf(tab) > 0 || frozenColumnCountOf(tab) > 0;
  }

  /** True when this cell sits in the frozen-row × frozen-column corner. */
  function isFrozenCorner(tab, rowIndex, columnIndex) {
    return isFrozenRow(tab, rowIndex) && columnIndex < frozenColumnCountOf(tab);
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  function setFreezeRows(tab, count, viewportHeight, start = 0) {
    if (!tab) return;
    const next = Math.max(0, Math.min(
      MAX_FROZEN_ROWS,
      maxFrozenRowsForViewport(tab, viewportHeight),
      Math.floor(Number(count) || 0),
    ));
    tab.frozenRowStart = next > 0 ? Math.max(0, Math.floor(Number(start) || 0)) : 0;
    tab.frozenRowCount = next;
  }

  function setFreezeColumns(tab, count) {
    if (!tab) return;
    const next = Math.max(0, Math.min(MAX_FROZEN_COLS, Math.floor(Number(count) || 0)));
    tab.frozenColumnCount = next;
  }

  function clearFreeze(tab) {
    if (!tab) return;
    tab.frozenRowStart = 0;
    tab.frozenRowCount = 0;
    tab.frozenColumnCount = 0;
  }

  return {
    frozenRowStartOf,
    frozenRowCountOf,
    frozenRowRangeOf,
    isFrozenRow,
    maxFrozenRowsForViewport,
    frozenColumnCountOf,
    frozenRowsHeight,
    fieldCommentBandHeight,
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

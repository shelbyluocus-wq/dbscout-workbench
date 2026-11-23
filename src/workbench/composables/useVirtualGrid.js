import { computed, getCurrentInstance, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  GRID_BOUNDARY_OVERLAY_CLEARANCE,
  GRID_FIELD_COMMENT_COLLAPSED_HEIGHT,
  GRID_HEADER_HEIGHT,
  VIRTUAL_BUFFER,
} from "../constants.js";
import { columnName } from "../utils/normalize.js";
import { isNumericColumnType } from "../utils/columnTypes.js";
import { useFreezePanes } from "./useFreezePanes.js";
import { ensureTabRowStore, tabRowCount } from "../rowStore.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "../utils/gridRowHeight.js";
import { buildRowKey } from "../utils/rowIdentity.js";
import { tableScrollRowCount, tableWindowOffset } from "../utils/tableScrollWindow.js";
import { computeColumnWindow, columnWidthsOf } from "./useVirtualColumns.js";

const ROW_INDEX_WIDTH = 38;
const RIGHT_EDGE_CLEARANCE = 12;

export function columnIntoViewScrollDelta(
  cellLeft,
  cellRight,
  leftBoundary,
  rightBoundary,
  { align = "nearest", margin = 0 } = {},
) {
  const visibleWidth = rightBoundary - leftBoundary;
  if (!Number.isFinite(visibleWidth) || visibleWidth <= 0) return 0;
  const cellWidth = cellRight - cellLeft;
  // Wide columns must pin the left edge: field names and remarks live there,
  // and aligning the right edge would scroll the identifier out of view.
  if (cellWidth >= visibleWidth) {
    return cellLeft - leftBoundary;
  }
  if (align === "center") {
    return cellLeft - (leftBoundary + (visibleWidth - cellWidth) / 2);
  }
  const safeMargin = Math.max(0, Math.min(Number(margin) || 0, (visibleWidth - cellWidth) / 2));
  const paddedLeft = leftBoundary + safeMargin;
  const paddedRight = rightBoundary - safeMargin;
  if (cellLeft < paddedLeft) {
    return cellLeft - paddedLeft;
  }
  if (cellRight > paddedRight) {
    return cellRight - paddedRight;
  }
  return 0;
}

function rowKeyAt(tab, row, absoluteIndex) {
  const precomputed = tab?.searchResultMode
    ? tab.searchResultRowKeys?.[absoluteIndex]
    : "";
  return precomputed || buildRowKey(tab, row);
}

function visibleInsertDrafts(tab) {
  if (!tab || tab.readOnly || tab.read_only || !Array.isArray(tab.insertDrafts)) return [];
  return tab.insertDrafts.filter((row) => row?.visible !== false);
}

function anchoredInsertCountBefore(tab, dataIndex, dataRowCount) {
  let count = 0;
  for (const row of visibleInsertDrafts(tab)) {
    const anchor = Number(row?.anchorIndex);
    if (
      row?.anchorIndex != null
      && Number.isInteger(anchor)
      && anchor >= 0
      && anchor < dataRowCount
      && anchor < dataIndex
    ) count += 1;
  }
  return count;
}

/**
 * Virtual scrolling for the data grid.
 *
 * @param {import('vue').ComputedRef} activeTab – computed active tab from the parent
 * @param {object} _editState – reserved for future use (not read here yet)
 * @param {object} [freezePanes] – useFreezePanes() instance; when not provided,
 *   a default one is created internally (column widths fall back to
 *   MIN_COL_WIDTH, which is a safe underestimate for scroll boundaries).
 *   Pass one in when you have a getColumnWidth function for precise geometry.
 */
export function useVirtualGrid(activeTab, _editState, freezePanes = null) {
  // ── DOM refs ──────────────────────────────────────────────────────────
  const gridWrapRef = ref(null);
  const scrollTop = ref(0);
  const scrollLeft = ref(0);
  const viewportWidth = ref(0);
  const pinnedColumnIndexes = ref([]);
  // Before the grid DOM exists, mount only the 20-row buffer plus one visible
  // row. ResizeObserver expands this to the real viewport immediately after
  // mount, keeping the cold first frame cheap for wide tables.
  const viewportHeight = ref(0);

  // Fall back to an internal freeze-panes helper so callers that don't have
  // a getColumnWidth function still get correct frozen-row math; frozen-column
  // widths use MIN_COL_WIDTH (conservative — scroll boundaries stay safe).
  const fp = freezePanes || useFreezePanes();

  // Frozen geometry derived from the active tab (zero when no freeze).
  // frozenColsW is declared after activeColumnMeta below (it depends on it).
  const rowHeight = computed(() => resolveGridRowHeight(activeTab.value));
  const windowOffset = computed(() => tableWindowOffset(activeTab.value));
  const configuredFrozenRowRange = computed(() => fp.frozenRowRangeOf(
    activeTab.value,
    tabRowCount(activeTab.value),
    viewportHeight.value,
  ));
  const frozenRowsActive = computed(() => {
    const range = configuredFrozenRowRange.value;
    return range.count > 0
      && scrollTop.value >= (windowOffset.value + range.start) * rowHeight.value;
  });
  const frozenRowRange = computed(() => {
    const range = configuredFrozenRowRange.value;
    return frozenRowsActive.value ? range : { start: range.start, count: 0, end: range.start };
  });
  const frozenRowStart = computed(() => frozenRowRange.value.start);
  const frozenRowCount = computed(() => frozenRowRange.value.count);
  const frozenRowBoundary = computed(() => frozenRowStart.value + frozenRowCount.value);
  const frozenRowsH = computed(() => frozenRowCount.value * rowHeight.value);

  // ── Computed: virtual window ──────────────────────────────────────────
  const virtualRange = computed((previous) => {
    const loadedTotal = tabRowCount(activeTab.value);
    const loadedStart = windowOffset.value;
    const loadedEnd = loadedStart + loadedTotal;
    // Once the table total is known, both top and bottom windows occupy their
    // real positions immediately. Loading another page fills that fixed space
    // instead of changing the scrollbar geometry.
    const total = tableScrollRowCount(activeTab.value, loadedTotal);
    const insertCount = visibleInsertDrafts(activeTab.value).length;
    if (total === 0 && insertCount === 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
    const rowH = rowHeight.value;
    const vpH = viewportHeight.value;
    const st = scrollTop.value;
    const frzStart = frozenRowStart.value;
    const frzRows = frozenRowCount.value;
    const globalFrozenStart = loadedStart + frzStart;
    const scrollableTotal = total - frzRows;
    // Virtualize the logical sequence after removing the anchored frozen
    // range. The source range below maps that sequence back to table indexes.
    const scrolledRows = Math.floor(Math.max(0, st) / rowH);
    const visibleCount = Math.ceil(vpH / rowH) + 1;
    const windowSize = visibleCount + VIRTUAL_BUFFER * 2;
    const maxScrollStart = Math.max(0, scrollableTotal - windowSize);
    const scrollStart = Math.min(Math.max(scrolledRows - VIRTUAL_BUFFER, 0), maxScrollStart);
    const scrollEnd = Math.min(scrollableTotal, scrollStart + windowSize);
    const sourceIndexAt = (scrollIndex) => (
      scrollIndex < globalFrozenStart ? scrollIndex : scrollIndex + frzRows
    );
    const scrollIndexAt = (sourceIndex) => (
      sourceIndex <= globalFrozenStart ? sourceIndex : sourceIndex - frzRows
    );
    const globalStart = scrollStart < scrollableTotal ? sourceIndexAt(scrollStart) : total;
    const globalEnd = scrollEnd > scrollStart ? sourceIndexAt(scrollEnd - 1) + 1 : globalStart;
    const renderStart = Math.min(loadedEnd, Math.max(loadedStart, globalStart));
    const renderEnd = Math.max(renderStart, Math.min(loadedEnd, globalEnd));
    const start = renderStart - loadedStart;
    const end = renderEnd - loadedStart;
    const padTop = (
      scrollIndexAt(renderStart)
      + anchoredInsertCountBefore(activeTab.value, start, loadedTotal)
    ) * rowH;
    const totalHeight = (scrollableTotal + insertCount) * rowH;
    if (previous && previous.start === start && previous.end === end
      && previous.padTop === padTop && previous.totalHeight === totalHeight) return previous;
    return { start, end, padTop, totalHeight };
  });

  const visibleRows = computed(() => {
    const tab = activeTab.value;
    const store = ensureTabRowStore(tab);
    void tab?.dataVersion;
    if (!store) return [];
    const { start, end } = virtualRange.value;
    const frozenStart = frozenRowStart.value;
    const frozenEnd = frozenStart + frozenRowCount.value;
    return [...store.iterateLoadedRange(start, end)]
      .filter(({ absoluteIndex }) => absoluteIndex < frozenStart || absoluteIndex >= frozenEnd)
      .map(({ row, absoluteIndex }) => {
        const originalIndex = absoluteIndex;
        const rowKey = rowKeyAt(tab, row, originalIndex);
        return { row, originalIndex, rowKey, rowVersion: store.rowVersion?.(absoluteIndex) || 0 };
      });
  });

  const activeColumnMeta = computed(() => (
    (Array.isArray(activeTab.value?.columns) ? activeTab.value.columns : []).map((column, columnIndex) => ({
      column,
      columnIndex,
      name: columnName(column),
      comment: column?.column_comment || column?.columnComment || "",
      isNumeric: isNumericColumnType(column?.column_type ?? column?.columnType),
    }))
  ));

  // Frozen-column total width (depends on activeColumnMeta). Uses MIN_COL_WIDTH
  // as a conservative fallback per column; precise widths are the renderer's job.
  const frozenColsW = computed(() => fp.frozenColumnsWidth(activeTab.value, activeColumnMeta.value));
  const columnWindow = computed((previous) => {
    const next = computeColumnWindow({
      widths: columnWidthsOf(activeTab.value, activeColumnMeta.value),
      frozenCount: fp.frozenColumnCountOf(activeTab.value),
      scrollLeft: scrollLeft.value,
      viewportWidth: viewportWidth.value,
      pinned: pinnedColumnIndexes.value,
    });
    if (previous && previous.signature === next.signature && previous.frozenCount === next.frozenCount
      && previous.offsets.length === next.offsets.length
      && previous.offsets.every((value, index) => value === next.offsets[index])) return previous;
    return next;
  });

  // ── Handlers ──────────────────────────────────────────────────────────
  let columnScrollToken = 0;
  let columnScrollRafId = 0;
  let pendingColumnScrollLeft = null;

  function cancelPendingColumnScroll() {
    columnScrollToken += 1;
    pendingColumnScrollLeft = null;
    if (columnScrollRafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(columnScrollRafId);
    }
    columnScrollRafId = 0;
  }

  function onGridScroll(event) {
    const nextLeft = Math.max(0, event.target.scrollLeft || 0);
    if (pendingColumnScrollLeft !== null && Math.abs(nextLeft - pendingColumnScrollLeft) > 2) {
      cancelPendingColumnScroll();
    }
    scrollLeft.value = nextLeft;
    scrollTop.value = Math.max(0, event.target.scrollTop);
    if (viewportHeight.value !== event.target.clientHeight) viewportHeight.value = event.target.clientHeight;
  }

  function setScrollTop(wrap, nextTop) {
    const normalized = Math.max(0, nextTop);
    // Keep the virtual window aligned when a programmatic scroll event is
    // deferred until a later WebView frame.
    scrollTop.value = normalized;
    wrap.scrollTop = normalized;
    const applied = Math.max(0, Number(wrap.scrollTop) || 0);
    if (applied !== normalized) scrollTop.value = applied;
    return applied;
  }

  function setScrollLeft(wrap, nextLeft) {
    const normalized = Math.max(0, Math.round(nextLeft));
    if (pendingColumnScrollLeft !== null) pendingColumnScrollLeft = normalized;
    scrollLeft.value = normalized;
    wrap.scrollLeft = normalized;
    const applied = Math.max(0, Number(wrap.scrollLeft) || 0);
    if (applied !== normalized) scrollLeft.value = applied;
    if (pendingColumnScrollLeft !== null) pendingColumnScrollLeft = applied;
    return applied;
  }

  function restoreGridScroll({ top = 0, left = 0 } = {}) {
    // Keep the reactive virtual window in sync with the DOM. Setting only the
    // element's scrollTop leaves a stale padTop until the browser emits a
    // scroll event, which can render a large blank band after switching tabs.
    cancelPendingColumnScroll();
    const normalizedTop = Math.max(0, Number(top) || 0);
    const normalizedLeft = Math.max(0, Number(left) || 0);
    const wrap = gridWrapRef.value;
    scrollTop.value = normalizedTop;
    scrollLeft.value = normalizedLeft;
    if (!wrap) return;
    setScrollTop(wrap, normalizedTop);
    wrap.scrollLeft = normalizedLeft;
  }

  function resetGridScroll() {
    restoreGridScroll();
  }

  function visibleViewportHeight(wrap) {
    const fallback = Math.max(0, Number(wrap?.clientHeight) || 0);
    const wrapRect = wrap?.getBoundingClientRect?.();
    const detailRect = wrap?.closest?.(".wb-workbench-pane")
      ?.querySelector?.(".wb-cell-detail")
      ?.getBoundingClientRect?.();
    if (
      !wrapRect
      || !detailRect
      || !Number.isFinite(wrapRect.top)
      || !Number.isFinite(wrapRect.bottom)
      || !Number.isFinite(detailRect.top)
      || !Number.isFinite(detailRect.bottom)
    ) return fallback;
    const overlapsHorizontally = !Number.isFinite(wrapRect.left)
      || !Number.isFinite(wrapRect.right)
      || !Number.isFinite(detailRect.left)
      || !Number.isFinite(detailRect.right)
      || (detailRect.right > wrapRect.left && detailRect.left < wrapRect.right);
    const overlapsVertically = detailRect.top < wrapRect.bottom && detailRect.bottom > wrapRect.top;
    if (!overlapsHorizontally || !overlapsVertically) return fallback;
    return Math.min(fallback, Math.max(0, detailRect.top - wrapRect.top));
  }

  function headerBandHeight(tab) {
    const fieldCommentHeight = tab?.fieldCommentsExpanded === false
      ? GRID_FIELD_COMMENT_COLLAPSED_HEIGHT
      : resolveFieldCommentHeight(tab);
    return GRID_HEADER_HEIGHT + fieldCommentHeight;
  }

  function scrollRowIntoView(rowIndex) {
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const frozenCount = frozenRowCount.value;
    const frozenEnd = frozenRowBoundary.value;
    if (frozenCount > 0 && rowIndex < frozenEnd) return;
    const frozenStart = frozenRowStart.value;
    const rowH = rowHeight.value;
    const scrollableIndex = rowIndex < frozenStart ? rowIndex : rowIndex - frozenCount;
    const rowTop = (windowOffset.value + frozenCount + scrollableIndex) * rowH;
    const rowBottom = rowTop + rowH;
    // The viewport top (for the scrollable region) starts below the header AND
    // below the frozen-row band, so a row is "above view" only when it sits
    // above that boundary.
    const vpTop = wrap.scrollTop + GRID_HEADER_HEIGHT + frozenRowsH.value;
    const visibleHeight = visibleViewportHeight(wrap);
    const headerHeight = headerBandHeight(activeTab.value);
    const vpBottom = wrap.scrollTop + visibleHeight - headerHeight - GRID_BOUNDARY_OVERLAY_CLEARANCE;
    if (rowTop < vpTop) setScrollTop(wrap, rowTop - GRID_HEADER_HEIGHT - frozenRowsH.value);
    else if (rowBottom > vpBottom) {
      setScrollTop(wrap, rowBottom - visibleHeight + headerHeight + GRID_BOUNDARY_OVERLAY_CLEARANCE);
    }
  }

  function findColumnCell(wrap, columnIndex, selectorPrefix = "td") {
    if (!wrap || typeof wrap.querySelector !== "function") return null;
    return wrap.querySelector(`${selectorPrefix}[data-column-index="${columnIndex}"], ${selectorPrefix} [data-insert-column-index="${columnIndex}"]`)
      || wrap.querySelector(`td[data-column-index="${columnIndex}"], th[data-column-index="${columnIndex}"], input[data-insert-column-index="${columnIndex}"]`)?.closest?.("td, th")
      || null;
  }

  function domColumnScrollBoundaries(wrap, wrapRect, frozenCount, fallbackFrozenWidth, align) {
    const visibleWrapWidth = Number(wrap.clientWidth) > 0
      ? Number(wrap.clientWidth)
      : (wrapRect.right - wrapRect.left);
    const rightEdge = wrapRect.left + visibleWrapWidth;
    // Left boundary must clear both the row-index gutter and the frozen-column
    // band, otherwise the target cell is hidden behind frozen columns.
    let leftBoundary = wrapRect.left + ROW_INDEX_WIDTH + fallbackFrozenWidth;
    if (typeof wrap.querySelector === "function") {
      const edgeElement = frozenCount > 0
        ? wrap.querySelector("th.frozen-col-edge, td.frozen-col-edge")
        : wrap.querySelector("th.wb-row-index, td.wb-row-index");
      const edgeRect = edgeElement?.getBoundingClientRect?.();
      if (edgeRect && Number.isFinite(edgeRect.right) && edgeRect.right > wrapRect.left) {
        leftBoundary = edgeRect.right;
      }
    }
    const clearance = align === "center"
      ? 0
      : Math.min(RIGHT_EDGE_CLEARANCE, Math.max(0, (rightEdge - leftBoundary) / 6));
    return {
      leftBoundary,
      rightBoundary: rightEdge - clearance,
    };
  }

  function applyVirtualColumnScroll(wrap, columnIndex, align, margin) {
    const window = columnWindow.value;
    if (!(viewportWidth.value > 0 && columnIndex >= 0 && columnIndex + 1 < window.offsets.length)) {
      return { usedVirtual: false, frozen: false };
    }
    if (columnIndex < window.frozenCount) {
      return { usedVirtual: true, frozen: true };
    }
    const currentLeft = Math.max(0, Number(wrap.scrollLeft) || 0);
    const clientWidth = Number(wrap.clientWidth) > 0 ? Number(wrap.clientWidth) : viewportWidth.value;
    const leftBoundary = currentLeft + window.frozenWidth;
    const rawRightBoundary = currentLeft + clientWidth - ROW_INDEX_WIDTH;
    const clearance = align === "center"
      ? 0
      : Math.min(RIGHT_EDGE_CLEARANCE, Math.max(0, (rawRightBoundary - leftBoundary) / 6));
    const delta = columnIntoViewScrollDelta(
      window.offsets[columnIndex],
      window.offsets[columnIndex + 1],
      leftBoundary,
      rawRightBoundary - clearance,
      { align, margin },
    );
    if (Math.abs(delta) > 0.5) {
      setScrollLeft(wrap, currentLeft + delta);
    } else {
      scrollLeft.value = currentLeft;
    }
    return { usedVirtual: true, frozen: false };
  }

  function applyDomColumnScroll(wrap, columnIndex, selectorPrefix, align, margin) {
    const cell = findColumnCell(wrap, columnIndex, selectorPrefix);
    if (!cell) return false;
    const wrapRect = wrap.getBoundingClientRect?.();
    const cellRect = cell.getBoundingClientRect?.();
    if (
      !wrapRect
      || !cellRect
      || !Number.isFinite(wrapRect.left)
      || !Number.isFinite(wrapRect.right)
      || !Number.isFinite(cellRect.left)
      || !Number.isFinite(cellRect.right)
      || cellRect.right <= cellRect.left
    ) return false;
    const window = columnWindow.value;
    const frozenWidth = window.frozenWidth > 0 ? window.frozenWidth : frozenColsW.value;
    const { leftBoundary, rightBoundary } = domColumnScrollBoundaries(
      wrap,
      wrapRect,
      window.frozenCount,
      frozenWidth,
      align,
    );
    const delta = columnIntoViewScrollDelta(
      cellRect.left,
      cellRect.right,
      leftBoundary,
      rightBoundary,
      { align, margin },
    );
    if (Math.abs(delta) > 1) {
      setScrollLeft(wrap, (Number(wrap.scrollLeft) || 0) + delta);
    }
    return true;
  }

  function scrollColumnIntoView(columnIndex, selectorPrefix = "td", options = {}) {
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const resolvedPrefix = typeof selectorPrefix === "string" ? selectorPrefix : "td";
    const resolvedOptions = (selectorPrefix && typeof selectorPrefix === "object" ? selectorPrefix : options) || {};
    const align = resolvedOptions.align === "center" ? "center" : "nearest";
    const margin = Number.isFinite(Number(resolvedOptions.margin))
      ? Math.max(0, Number(resolvedOptions.margin))
      : 0;

    cancelPendingColumnScroll();
    const token = columnScrollToken;
    const targetTabId = activeTab.value?.id;
    const virtual = applyVirtualColumnScroll(wrap, columnIndex, align, margin);
    if (virtual.frozen) return;
    if (!virtual.usedVirtual) {
      applyDomColumnScroll(wrap, columnIndex, resolvedPrefix, align, margin);
      return;
    }

    // Virtual column offsets are an estimate: after Vue paints the target
    // column (and after any next-frame auto-fit completes), reconcile against
    // the actual rendered cell geometry so wide tables never clip the cell.
    pendingColumnScrollLeft = Math.max(0, Number(wrap.scrollLeft) || 0);
    const isStillActive = () => (
      token === columnScrollToken
      && gridWrapRef.value === wrap
      && activeTab.value?.id === targetTabId
      && (pendingColumnScrollLeft === null || Math.abs((Number(wrap.scrollLeft) || 0) - pendingColumnScrollLeft) <= 2)
    );
    const reconcileRenderedCell = (allowVirtualRetry) => {
      if (!isStillActive()) return;
      const matched = applyDomColumnScroll(wrap, columnIndex, resolvedPrefix, align, margin);
      if (!matched && allowVirtualRetry) {
        const retry = applyVirtualColumnScroll(wrap, columnIndex, align, margin);
        if (retry.frozen) {
          pendingColumnScrollLeft = null;
          return;
        }
        pendingColumnScrollLeft = Math.max(0, Number(wrap.scrollLeft) || 0);
        nextTick(() => {
          if (!isStillActive()) return;
          applyDomColumnScroll(wrap, columnIndex, resolvedPrefix, align, margin);
          pendingColumnScrollLeft = Math.max(0, Number(wrap.scrollLeft) || 0);
        });
        return;
      }
      pendingColumnScrollLeft = Math.max(0, Number(wrap.scrollLeft) || 0);
    };

    nextTick(() => {
      reconcileRenderedCell(true);
      if (!isStillActive() || typeof requestAnimationFrame !== "function") {
        if (token === columnScrollToken) pendingColumnScrollLeft = null;
        return;
      }
      if (align === "center") {
        columnScrollRafId = requestAnimationFrame(() => {
          columnScrollRafId = 0;
          nextTick(() => {
            reconcileRenderedCell(true);
            if (token === columnScrollToken) pendingColumnScrollLeft = null;
          });
        });
      } else {
        pendingColumnScrollLeft = null;
      }
    });
  }

  function scrollCellIntoView(rowIndex, columnIndex, options = {}) {
    scrollRowIntoView(rowIndex);
    const align = options?.alignColumn || options?.align;
    const columnOptions = align ? { align } : undefined;
    nextTick(() => {
      scrollColumnIntoView(columnIndex, "td", columnOptions);
    });
  }

  function scrollInsertRowIntoView(rowIndex = null) {
    const wrap = gridWrapRef.value;
    const total = tabRowCount(activeTab.value);
    if (!wrap) return;
    const targetIndex = Number.isFinite(rowIndex) ? Math.max(0, rowIndex) : total;
    const rowH = rowHeight.value;
    const rowTop = (windowOffset.value + targetIndex) * rowH;
    const rowBottom = rowTop + rowH;
    const vpTop = wrap.scrollTop + GRID_HEADER_HEIGHT;
    const vpBottom = wrap.scrollTop + wrap.clientHeight - GRID_BOUNDARY_OVERLAY_CLEARANCE;
    if (rowTop < vpTop) setScrollTop(wrap, rowTop - GRID_HEADER_HEIGHT);
    else if (rowBottom > vpBottom) {
      setScrollTop(wrap, rowBottom - wrap.clientHeight + GRID_BOUNDARY_OVERLAY_CLEARANCE);
    }
  }

  function scrollInsertCellIntoView(columnIndex, rowIndex = null, { scrollColumn = true } = {}) {
    scrollInsertRowIntoView(rowIndex);
    if (scrollColumn) requestAnimationFrame(() => scrollColumnIntoView(columnIndex));
  }

  // ── ResizeObserver (lifecycle-tied via watch on the ref) ─────────────
  let resizeObserver = null;

  watch(gridWrapRef, (el) => {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    if (!el) return;
    viewportHeight.value = el.clientHeight;
    viewportWidth.value = el.clientWidth || 0;
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewportHeight.value = entry.contentRect.height;
        viewportWidth.value = el.clientWidth || entry.contentRect.width || 0;
      }
    });
    resizeObserver.observe(el);
  });

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      cancelPendingColumnScroll();
      if (resizeObserver) resizeObserver.disconnect();
    });
  }

  return {
    gridWrapRef,
    scrollTop,
    scrollLeft,
    viewportWidth,
    columnWindow,
    pinnedColumnIndexes,
    viewportHeight,
    virtualRange,
    visibleRows,
    activeColumnMeta,
    onGridScroll,
    restoreGridScroll,
    resetGridScroll,
    scrollRowIntoView,
    scrollColumnIntoView,
    scrollCellIntoView,
    scrollInsertRowIntoView,
    scrollInsertCellIntoView,
    // Freeze-panes geometry (zero-valued when freezePanes not wired in).
    frozenRowsHeight: frozenRowsH,
    frozenColumnsWidth: frozenColsW,
    frozenRowStart,
    frozenRowCount,
    frozenRowBoundary,
    frozenRowsActive,
    rowHeight,
  };
}

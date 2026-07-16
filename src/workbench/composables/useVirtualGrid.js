import { computed, getCurrentInstance, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { GRID_FIELD_COMMENT_COLLAPSED_HEIGHT, GRID_HEADER_HEIGHT, VIRTUAL_BUFFER } from "../constants.js";
import { columnName } from "../utils/normalize.js";
import { useFreezePanes } from "./useFreezePanes.js";
import { ensureTabRowStore, tabRowCount } from "../rowStore.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "../utils/gridRowHeight.js";

const ROW_INDEX_WIDTH = 38;
import { buildRowKey } from "../utils/rowIdentity.js";

function rowKeyAt(tab, row, absoluteIndex) {
  const precomputed = tab?.searchResultMode
    ? tab.searchResultRowKeys?.[absoluteIndex]
    : "";
  return precomputed || buildRowKey(tab, row);
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
  const configuredFrozenRowRange = computed(() => fp.frozenRowRangeOf(
    activeTab.value,
    tabRowCount(activeTab.value),
    viewportHeight.value,
  ));
  const frozenRowsActive = computed(() => {
    const range = configuredFrozenRowRange.value;
    return range.count > 0 && scrollTop.value >= range.start * rowHeight.value;
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
  const virtualRange = computed(() => {
    const total = tabRowCount(activeTab.value);
    if (total === 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
    const rowH = rowHeight.value;
    const vpH = viewportHeight.value;
    const st = scrollTop.value;
    const frzStart = frozenRowStart.value;
    const frzRows = frozenRowCount.value;
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
      scrollIndex < frzStart ? scrollIndex : scrollIndex + frzRows
    );
    const start = scrollStart < scrollableTotal ? sourceIndexAt(scrollStart) : total;
    const end = scrollEnd > scrollStart ? sourceIndexAt(scrollEnd - 1) + 1 : start;
    const padTop = scrollStart * rowH;
    const totalHeight = scrollableTotal * rowH;
    return { start, end, padTop, totalHeight };
  });

  const visibleRows = computed(() => {
    const tab = activeTab.value;
    const store = ensureTabRowStore(tab);
    if (!store) return [];
    const { start, end } = virtualRange.value;
    const frozenStart = frozenRowStart.value;
    const frozenEnd = frozenStart + frozenRowCount.value;
    return [...store.iterateLoadedRange(start, end)]
      .filter(({ absoluteIndex }) => absoluteIndex < frozenStart || absoluteIndex >= frozenEnd)
      .map(({ row, absoluteIndex }) => {
        const originalIndex = absoluteIndex;
        const rowKey = rowKeyAt(tab, row, originalIndex);
        return { row, originalIndex, rowKey };
      });
  });

  const activeColumnMeta = computed(() => (
    (Array.isArray(activeTab.value?.columns) ? activeTab.value.columns : []).map((column, columnIndex) => ({
      column,
      columnIndex,
      name: columnName(column),
      comment: column?.column_comment || column?.columnComment || "",
    }))
  ));

  // Frozen-column total width (depends on activeColumnMeta). Uses MIN_COL_WIDTH
  // as a conservative fallback per column; precise widths are the renderer's job.
  const frozenColsW = computed(() => fp.frozenColumnsWidth(activeTab.value, activeColumnMeta.value));

  // ── Handlers ──────────────────────────────────────────────────────────
  function onGridScroll(event) {
    scrollTop.value = Math.max(0, event.target.scrollTop);
    if (viewportHeight.value !== event.target.clientHeight) viewportHeight.value = event.target.clientHeight;
  }

  function setScrollTop(wrap, nextTop) {
    const normalized = Math.max(0, nextTop);
    wrap.scrollTop = normalized;
    scrollTop.value = normalized;
  }

  function restoreGridScroll({ top = 0, left = 0 } = {}) {
    // Keep the reactive virtual window in sync with the DOM. Setting only the
    // element's scrollTop leaves a stale padTop until the browser emits a
    // scroll event, which can render a large blank band after switching tabs.
    const normalizedTop = Math.max(0, Number(top) || 0);
    const normalizedLeft = Math.max(0, Number(left) || 0);
    scrollTop.value = normalizedTop;
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    wrap.scrollTop = normalizedTop;
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
    const rowTop = (frozenCount + scrollableIndex) * rowH;
    const rowBottom = rowTop + rowH;
    // The viewport top (for the scrollable region) starts below the header AND
    // below the frozen-row band, so a row is "above view" only when it sits
    // above that boundary.
    const vpTop = wrap.scrollTop + GRID_HEADER_HEIGHT + frozenRowsH.value;
    const visibleHeight = visibleViewportHeight(wrap);
    const headerHeight = headerBandHeight(activeTab.value);
    const vpBottom = wrap.scrollTop + visibleHeight - headerHeight - GRID_HEADER_HEIGHT;
    if (rowTop < vpTop) setScrollTop(wrap, rowTop - GRID_HEADER_HEIGHT - frozenRowsH.value);
    else if (rowBottom > vpBottom) {
      setScrollTop(wrap, rowBottom - visibleHeight + headerHeight + GRID_HEADER_HEIGHT);
    }
  }

  function scrollColumnIntoView(columnIndex, selectorPrefix = "td") {
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const cell = wrap.querySelector(`${selectorPrefix}[data-column-index="${columnIndex}"], ${selectorPrefix} [data-insert-column-index="${columnIndex}"]`)
      || wrap.querySelector(`td[data-column-index="${columnIndex}"], th[data-column-index="${columnIndex}"], input[data-insert-column-index="${columnIndex}"]`)?.closest("td, th");
    if (!cell) return;
    const wrapRect = wrap.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    // Left boundary must clear both the row-index gutter and the frozen-column
    // band, otherwise the target cell is hidden behind frozen columns.
    const leftBoundary = wrapRect.left + ROW_INDEX_WIDTH + frozenColsW.value;
    const rightBoundary = wrapRect.right;
    if (cellRect.left < leftBoundary) wrap.scrollLeft -= leftBoundary - cellRect.left;
    else if (cellRect.right > rightBoundary) wrap.scrollLeft += cellRect.right - rightBoundary;
  }

  function scrollCellIntoView(rowIndex, columnIndex) {
    scrollRowIntoView(rowIndex);
    nextTick(() => {
      scrollRowIntoView(rowIndex);
      scrollColumnIntoView(columnIndex);
      requestAnimationFrame(() => {
        scrollRowIntoView(rowIndex);
        scrollColumnIntoView(columnIndex);
      });
    });
  }

  function scrollInsertRowIntoView(rowIndex = null) {
    const wrap = gridWrapRef.value;
    const total = tabRowCount(activeTab.value);
    if (!wrap) return;
    const targetIndex = Number.isFinite(rowIndex) ? Math.max(0, rowIndex) : total;
    const rowH = rowHeight.value;
    const rowTop = targetIndex * rowH;
    const rowBottom = rowTop + rowH;
    const vpTop = wrap.scrollTop + GRID_HEADER_HEIGHT;
    const vpBottom = wrap.scrollTop + wrap.clientHeight;
    if (rowTop < vpTop) setScrollTop(wrap, rowTop - GRID_HEADER_HEIGHT);
    else if (rowBottom > vpBottom) setScrollTop(wrap, rowBottom - wrap.clientHeight);
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
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewportHeight.value = entry.contentRect.height;
      }
    });
    resizeObserver.observe(el);
  });

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (resizeObserver) resizeObserver.disconnect();
    });
  }

  return {
    gridWrapRef,
    scrollTop,
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

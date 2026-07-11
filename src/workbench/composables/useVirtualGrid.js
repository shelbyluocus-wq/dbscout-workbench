import { computed, getCurrentInstance, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { GRID_ROW_HEIGHT, VIRTUAL_BUFFER } from "../constants.js";
import { columnName } from "../utils/normalize.js";
import { useFreezePanes } from "./useFreezePanes.js";
import { ensureTabRowStore, tabRowCount } from "../rowStore.js";

const GRID_HEADER_HEIGHT = 28;
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
  const viewportHeight = ref(600);

  // Fall back to an internal freeze-panes helper so callers that don't have
  // a getColumnWidth function still get correct frozen-row math; frozen-column
  // widths use MIN_COL_WIDTH (conservative — scroll boundaries stay safe).
  const fp = freezePanes || useFreezePanes();

  // Frozen geometry derived from the active tab (zero when no freeze).
  // frozenColsW is declared after activeColumnMeta below (it depends on it).
  const frozenRowsH = computed(() => fp.frozenRowsHeight(activeTab.value));
  const frozenRowCount = computed(() => fp.frozenRowCountOf(activeTab.value));

  // ── Computed: virtual window ──────────────────────────────────────────
  const virtualRange = computed(() => {
    const total = tabRowCount(activeTab.value);
    if (total === 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
    const rowH = GRID_ROW_HEIGHT;
    const vpH = viewportHeight.value;
    const st = scrollTop.value;
    const frzH = frozenRowsH.value;
    const frzRows = frozenRowCount.value;
    const firstScrollable = Math.min(frzRows, total);
    // Frozen rows render separately and stay pinned above the scrollable seam.
    // Use the real scroll offset for the virtual window, then offset by the
    // frozen row count so rows visible below the frozen band are mounted.
    const scrolledRows = Math.floor(Math.max(0, st) / rowH);
    const visibleCount = Math.ceil(vpH / rowH) + 1;
    const windowSize = visibleCount + VIRTUAL_BUFFER * 2;
    const minStart = firstScrollable;
    const maxStart = Math.max(minStart, total - windowSize);
    let start = firstScrollable + scrolledRows - VIRTUAL_BUFFER;
    start = Math.min(Math.max(start, minStart), maxStart);
    let end = Math.min(total, start + windowSize);
    // padTop positions the first rendered non-frozen row. It's the absolute
    // offset of `start`-th row minus the frozen band (which renders separately
    // above this region), clamped at 0.
    const padTop = Math.max(0, start * rowH - frzH);
    // totalHeight spans only the non-frozen rows; the frozen band adds its own
    // height via a separate render path, so the spacer must not double-count it.
    const totalHeight = Math.max(0, total * rowH - frzH);
    return { start, end, padTop, totalHeight };
  });

  const visibleRows = computed(() => {
    const tab = activeTab.value;
    const store = ensureTabRowStore(tab);
    if (!store) return [];
    const { start, end } = virtualRange.value;
    return [...store.iterateLoadedRange(start, end)].map(({ row, absoluteIndex }) => {
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
    scrollTop.value = event.target.scrollTop;
    if (viewportHeight.value !== event.target.clientHeight) viewportHeight.value = event.target.clientHeight;
  }

  function setScrollTop(wrap, nextTop) {
    const normalized = Math.max(0, nextTop);
    wrap.scrollTop = normalized;
    scrollTop.value = normalized;
  }

  function resetGridScroll() {
    // Keep the reactive virtual window in sync with the DOM. Setting only the
    // element's scrollTop leaves a stale padTop until the browser emits a
    // scroll event, which can render a large blank band after switching tabs.
    scrollTop.value = 0;
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    wrap.scrollTop = 0;
    wrap.scrollLeft = 0;
  }

  function scrollRowIntoView(rowIndex) {
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    if (rowIndex < frozenRowCount.value) return;
    const rowTop = rowIndex * GRID_ROW_HEIGHT;
    const rowBottom = rowTop + GRID_ROW_HEIGHT;
    // The viewport top (for the scrollable region) starts below the header AND
    // below the frozen-row band, so a row is "above view" only when it sits
    // above that boundary.
    const vpTop = wrap.scrollTop + GRID_HEADER_HEIGHT + frozenRowsH.value;
    const vpBottom = wrap.scrollTop + wrap.clientHeight - GRID_HEADER_HEIGHT;
    if (rowTop < vpTop) setScrollTop(wrap, rowTop - GRID_HEADER_HEIGHT - frozenRowsH.value);
    else if (rowBottom > vpBottom) setScrollTop(wrap, rowBottom - wrap.clientHeight + GRID_HEADER_HEIGHT);
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
    const rowTop = targetIndex * GRID_ROW_HEIGHT;
    const rowBottom = rowTop + GRID_ROW_HEIGHT;
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
    resetGridScroll,
    scrollRowIntoView,
    scrollColumnIntoView,
    scrollCellIntoView,
    scrollInsertRowIntoView,
    scrollInsertCellIntoView,
    // Freeze-panes geometry (zero-valued when freezePanes not wired in).
    frozenRowsHeight: frozenRowsH,
    frozenColumnsWidth: frozenColsW,
    frozenRowCount,
  };
}

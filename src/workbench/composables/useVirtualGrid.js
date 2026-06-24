import { computed, getCurrentInstance, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { GRID_ROW_HEIGHT, VIRTUAL_BUFFER } from "../constants.js";

const GRID_HEADER_HEIGHT = 28;
const ROW_INDEX_WIDTH = 38;
import { buildRowKey } from "../utils/rowIdentity.js";

/**
 * Virtual scrolling for the data grid.
 *
 * @param {import('vue').ComputedRef} activeTab – computed active tab from the parent
 * @param {object} _editState – reserved for future use (not read here yet)
 */
export function useVirtualGrid(activeTab, _editState) {
  // ── DOM refs ──────────────────────────────────────────────────────────
  const gridWrapRef = ref(null);
  const scrollTop = ref(0);
  const viewportHeight = ref(600);

  // ── Computed: virtual window ──────────────────────────────────────────
  const virtualRange = computed(() => {
    const total = activeTab.value?.rows?.length || 0;
    if (total === 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
    const rowH = GRID_ROW_HEIGHT;
    const vpH = viewportHeight.value;
    const st = scrollTop.value;
    const totalHeight = total * rowH;
    const visibleCount = Math.ceil(vpH / rowH) + 1;
    let start = Math.max(0, Math.floor(st / rowH) - VIRTUAL_BUFFER);
    let end = Math.min(total, start + visibleCount + VIRTUAL_BUFFER * 2);
    return { start, end, padTop: start * rowH, totalHeight };
  });

  const visibleRows = computed(() => {
    const tab = activeTab.value;
    if (!tab?.rows) return [];
    const { start, end } = virtualRange.value;
    return tab.rows.slice(start, end).map((row, i) => {
      const originalIndex = start + i;
      const rowKey = buildRowKey(tab, row);
      return { row, originalIndex, rowKey };
    });
  });

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

  function scrollRowIntoView(rowIndex) {
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const rowTop = rowIndex * GRID_ROW_HEIGHT;
    const rowBottom = rowTop + GRID_ROW_HEIGHT;
    const vpTop = wrap.scrollTop + GRID_HEADER_HEIGHT;
    const vpBottom = wrap.scrollTop + wrap.clientHeight - GRID_HEADER_HEIGHT;
    if (rowTop < vpTop) setScrollTop(wrap, rowTop - GRID_HEADER_HEIGHT);
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
    const leftBoundary = wrapRect.left + ROW_INDEX_WIDTH;
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
    const total = activeTab.value?.rows?.length || 0;
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
    onGridScroll,
    scrollRowIntoView,
    scrollColumnIntoView,
    scrollCellIntoView,
    scrollInsertRowIntoView,
    scrollInsertCellIntoView,
  };
}

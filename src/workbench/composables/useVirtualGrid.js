import { computed, ref, watch } from "vue";
import { GRID_ROW_HEIGHT, VIRTUAL_BUFFER } from "../constants.js";
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
    viewportHeight.value = event.target.clientHeight;
  }

  function scrollRowIntoView(rowIndex) {
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const rowTop = rowIndex * GRID_ROW_HEIGHT;
    const rowBottom = rowTop + GRID_ROW_HEIGHT;
    const vpTop = wrap.scrollTop;
    const vpBottom = vpTop + wrap.clientHeight;
    if (rowTop < vpTop) wrap.scrollTop = rowTop;
    else if (rowBottom > vpBottom) wrap.scrollTop = rowBottom - wrap.clientHeight;
  }

  // ── ResizeObserver (lifecycle-tied via watch on the ref) ─────────────
  watch(gridWrapRef, (el) => {
    if (!el) return;
    viewportHeight.value = el.clientHeight;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewportHeight.value = entry.contentRect.height;
      }
    });
    ro.observe(el);
  });

  return {
    gridWrapRef,
    scrollTop,
    viewportHeight,
    virtualRange,
    visibleRows,
    onGridScroll,
    scrollRowIntoView,
  };
}

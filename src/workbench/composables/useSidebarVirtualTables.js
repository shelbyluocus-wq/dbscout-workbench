import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from "vue";
import { SIDEBAR_TABLE_ROW_HEIGHT, VIRTUAL_BUFFER } from "../constants.js";

export const SIDEBAR_TABLE_BRANCH_MAX_HEIGHT = 600;
const SIDEBAR_TABLE_LIST_TOP_FALLBACK = 40;
const SIDEBAR_TABLE_BRANCH_PADDING_TOP = 3;

/**
 * Sizes the expanded table branch to its content while preserving a scrollable
 * viewport cap for larger databases.
 */
export function computeTableBranchMinHeight({
  tableHeight = 0,
  listTop = 0,
  searching = false,
  maxHeight = SIDEBAR_TABLE_BRANCH_MAX_HEIGHT,
} = {}) {
  const cap = Number.isFinite(Number(maxHeight)) && Number(maxHeight) > 0
    ? Math.max(SIDEBAR_TABLE_BRANCH_MAX_HEIGHT, Math.round(Number(maxHeight)))
    : SIDEBAR_TABLE_BRANCH_MAX_HEIGHT;
  if (searching) return cap;

  const contentHeight = Math.max(0, Number(tableHeight) || 0);
  const measuredListTop = Math.max(SIDEBAR_TABLE_LIST_TOP_FALLBACK, Number(listTop) || 0);
  const contentHeightWithChrome = measuredListTop + contentHeight + SIDEBAR_TABLE_BRANCH_PADDING_TOP;
  return Math.min(cap, contentHeightWithChrome);
}

/**
 * Pure window computation for the sidebar table list.
 *
 * The expanded database owns a dedicated scroll container; the table list sits
 * at content-offset `listTop` within it. Given the current scroll
 * position we compute which slice of rows to render plus the spacer geometry
 * that keeps the scrollbar (and the expand animation's height measurement)
 * honest.
 *
 * @param {object} p
 * @param {number} p.scrollTop      scrollTop of the dedicated table container
 * @param {number} p.listTop        offset of the table list top within scroll content
 * @param {number} p.viewportHeight visible height of the scroll container
 * @param {number} p.rowHeight      per-row height (px)
 * @param {number} p.total          total table count
 * @param {number} [p.buffer]       extra rows rendered above/below the viewport
 * @returns {{ start: number, end: number, padTop: number, totalHeight: number }}
 */
export function computeTableWindow({
  scrollTop,
  listTop,
  viewportHeight,
  rowHeight,
  total,
  buffer = VIRTUAL_BUFFER,
}) {
  const rowH = rowHeight > 0 ? rowHeight : SIDEBAR_TABLE_ROW_HEIGHT;
  const count = total > 0 ? total : 0;
  const totalHeight = count * rowH;
  if (count === 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };

  // Scroll position relative to the top of the table list.
  const relScroll = scrollTop - listTop;
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowH) + 1);

  const windowSize = visibleCount + buffer * 2;
  const maxStart = Math.max(0, count - windowSize);

  let start = Math.floor(relScroll / rowH) - buffer;
  if (start < 0) start = 0;
  if (start > maxStart) start = maxStart;

  let end = start + windowSize;
  if (end > count) end = count;

  return { start, end, padTop: start * rowH, totalHeight };
}

export function resolveListElement(value) {
  if (Array.isArray(value)) return resolveListElement(value[0] || null);
  return value && typeof value.querySelector === "function" && typeof value.getBoundingClientRect === "function"
    ? value
    : null;
}

export function measureStickyTopInset(container, selector) {
  if (!container || !selector || typeof container.querySelector !== "function") return 0;
  const header = container.querySelector(selector);
  if (!header || typeof header.getBoundingClientRect !== "function") return 0;
  const containerRect = container.getBoundingClientRect?.() || { top: 0 };
  const headerRect = header.getBoundingClientRect();
  const inset = (Number(headerRect.bottom) || 0) - (Number(containerRect.top) || 0);
  return Math.max(0, Math.min(Number(container.clientHeight) || inset, inset));
}

/**
 * Virtual scrolling for the sidebar table list. Keeps mounted DOM proportional
 * to the viewport instead of the (uncapped) table count, so expanding a large
 * database branch stays smooth.
 *
 * @param {object} p
 * @param {import('vue').Ref<HTMLElement|null>} p.scrollContainerRef the dedicated table viewport
 * @param {import('vue').Ref<HTMLElement|null>} p.listElRef          the `.wb-table-vlist` element
 * @param {import('vue').Ref<Array>|import('vue').ComputedRef<Array>} p.tables the full table list
 * @param {string} [p.stickyHeaderSelector] sticky header inside the table viewport
 */
export function useSidebarVirtualTables({ scrollContainerRef, listElRef, tables, stickyHeaderSelector = "" }) {
  const scrollTop = ref(0);
  const viewportHeight = ref(600);
  const listTop = ref(0);
  const rowHeight = ref(SIDEBAR_TABLE_ROW_HEIGHT);
  const stickyTopInset = ref(0);

  const total = computed(() => (Array.isArray(tables.value) ? tables.value.length : 0));

  const virtualRange = computed(() =>
    computeTableWindow({
      scrollTop: scrollTop.value,
      listTop: listTop.value,
      viewportHeight: viewportHeight.value,
      rowHeight: rowHeight.value,
      total: total.value,
    }),
  );

  const visibleTables = computed(() => {
    const list = tables.value;
    if (!Array.isArray(list) || !list.length) return [];
    const { start, end } = virtualRange.value;
    return list.slice(start, end).map((table, i) => ({ table, index: start + i }));
  });

  // ── Measurement ────────────────────────────────────────────────────────
  // `listTop` is invariant to scrolling (the list's top offset in content
  // coordinates only shifts when content *above* it changes), so we only
  // remeasure on layout-affecting events, not on every scroll frame.
  function measureListTop() {
    const container = resolveListElement(scrollContainerRef.value);
    const listEl = resolveListElement(listElRef.value);
    if (!container || !listEl) return;
    const containerRect = container.getBoundingClientRect();
    const listRect = listEl.getBoundingClientRect();
    listTop.value = listRect.top - containerRect.top + container.scrollTop;
  }

  function measureRowHeight() {
    const listEl = resolveListElement(listElRef.value);
    if (!listEl) return;
    const firstRow = listEl.querySelector(".wb-table-item");
    if (!firstRow) return;
    const height = firstRow.getBoundingClientRect().height;
    if (height > 0 && Math.abs(height - rowHeight.value) > 0.5) rowHeight.value = height;
  }

  function syncViewport() {
    const container = resolveListElement(scrollContainerRef.value);
    if (!container) return;
    stickyTopInset.value = measureStickyTopInset(container, stickyHeaderSelector);
    viewportHeight.value = Math.max(0, container.clientHeight - stickyTopInset.value);
  }

  let remeasureRaf = 0;
  function remeasure() {
    if (typeof requestAnimationFrame !== "function") {
      syncViewport();
      measureRowHeight();
      measureListTop();
      return;
    }
    if (remeasureRaf) return;
    remeasureRaf = requestAnimationFrame(() => {
      remeasureRaf = 0;
      syncViewport();
      measureRowHeight();
      measureListTop();
    });
  }

  function onScroll() {
    const container = resolveListElement(scrollContainerRef.value);
    if (!container) return;
    scrollTop.value = container.scrollTop;
    // Read the live viewport on native scrolling too. This recovers immediately if
    // the branch finished a flex/transition resize before ResizeObserver delivered.
    const measuredClientHeight = viewportHeight.value + stickyTopInset.value;
    if (Math.abs(container.clientHeight - measuredClientHeight) > 0.5) syncViewport();
  }

  // ── Reveal (index-based; replaces DOM querySelector lookup) ─────────────
  function scrollTableIntoView(index, { margin = 48, smooth = true } = {}) {
    const container = resolveListElement(scrollContainerRef.value);
    if (!container || !Number.isFinite(index) || index < 0) return;
    measureRowHeight();
    measureListTop();
    syncViewport();
    const rowH = rowHeight.value > 0 ? rowHeight.value : SIDEBAR_TABLE_ROW_HEIGHT;
    const rowTop = listTop.value + index * rowH;
    const rowBottom = rowTop + rowH;
    const viewTop = container.scrollTop + stickyTopInset.value + margin;
    const viewBottom = container.scrollTop + container.clientHeight - margin;
    const behavior = smooth ? "smooth" : "auto";
    if (rowTop < viewTop) {
      container.scrollTo({ top: Math.max(0, rowTop - stickyTopInset.value - margin), behavior });
    } else if (rowBottom > viewBottom) {
      container.scrollTo({ top: Math.max(0, rowBottom - container.clientHeight + margin), behavior });
    }
  }

  // ── Lifecycle wiring ────────────────────────────────────────────────────
  let resizeObserver = null;
  let attached = null;

  function attach(container) {
    container = resolveListElement(container);
    if (attached === container) return;
    detach();
    if (!container) return;
    attached = container;
    container.addEventListener("scroll", onScroll, { passive: true });
    scrollTop.value = container.scrollTop;
    syncViewport();
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        syncViewport();
        remeasure();
      });
      resizeObserver.observe(container);
    }
    remeasure();
  }

  function detach() {
    if (attached) attached.removeEventListener("scroll", onScroll);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    attached = null;
  }

  // v-for template refs may populate their array in place instead of replacing
  // the Ref value. Watch the resolved first element so index mutations still bind.
  watch(
    () => resolveListElement(scrollContainerRef.value),
    (element) => attach(element),
    { immediate: true, flush: "post" },
  );
  // The list element is re-created every time the branch re-expands, and the
  // list top shifts when the connection branch (content above) grows/shrinks.
  watch(
    () => resolveListElement(listElRef.value),
    () => remeasure(),
    { immediate: true, flush: "post" },
  );
  watch(total, () => remeasure());

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (remeasureRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(remeasureRaf);
      detach();
    });
  }

  return {
    scrollTop,
    viewportHeight,
    listTop,
    rowHeight,
    stickyTopInset,
    virtualRange,
    visibleTables,
    remeasure,
    scrollTableIntoView,
    scrollContainer: () => resolveListElement(scrollContainerRef.value),
    dispose: detach,
  };
}

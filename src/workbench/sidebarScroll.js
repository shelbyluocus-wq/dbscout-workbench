const PRIMARY_RESULT_SELECTOR = ".wb-search-result";
const EMPTY_RESULT_SELECTOR = ".wb-tree-empty, .wb-search-hint";
const FALLBACK_RESULT_SELECTOR = ".wb-value-search-progress-wrap, .wb-table-branch > .wb-tree-row.wb-table-item";
const RESULT_TOP_GAP = 4;

function elementHeight(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect?.();
  return Number(element.offsetHeight) || Math.max(0, Number(rect?.bottom) - Number(rect?.top)) || 0;
}

function scrollToTop(container, top, behavior = "auto") {
  const nextTop = Math.max(0, Math.round(Number(top) || 0));
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top: nextTop, behavior });
  } else {
    container.scrollTop = nextTop;
  }
}

function isElementInView(element, top, bottom) {
  if (!element) return false;
  const rect = element.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  return Number(rect.top) >= Number(top) && Number(rect.bottom) <= Number(bottom);
}

function isSearchBoxInView(container, searchBox) {
  if (!searchBox) return false;
  const containerRect = container.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  const boxRect = searchBox.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  return Number(boxRect.bottom) > Number(containerRect.top) && Number(boxRect.top) < Number(containerRect.bottom);
}

/**
 * Reveals a database row with nearest-edge semantics without pinning it to the top.
 * The outer navigation moves only when the row is actually clipped.
 */
export function revealSidebarNavigationRow(container, row, { behavior = "auto" } = {}) {
  if (!container || !row) return false;
  const containerRect = container.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  const rowRect = row.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  let delta = 0;
  if (Number(rowRect.top) < Number(containerRect.top)) {
    delta = Number(rowRect.top) - Number(containerRect.top);
  } else if (Number(rowRect.bottom) > Number(containerRect.bottom)) {
    delta = Number(rowRect.bottom) - Number(containerRect.bottom);
  }
  if (!delta) return false;
  scrollToTop(container, (Number(container.scrollTop) || 0) + delta, behavior);
  return true;
}

/**
 * 进入搜索态时，惰性地把搜索上下文带回视野。
 *
 * 与旧的「每次按键都瞬间滚动对齐」不同，这里只在必要时滚动、且默认平滑：
 * - 若首个结果已完整出现在粘性搜索框下方 → 不滚动，视图保持稳定。
 * - 否则平滑滚动，使首个结果对齐到搜索框正下方。
 *
 * @param {HTMLElement} container 当前数据库的独立表区滚动容器
 * @param {{ smooth?: boolean }} [options]
 * @returns {boolean} 是否执行了滚动
 */
export function revealSidebarSearchResults(container, { smooth = true } = {}) {
  if (!container) return false;

  const behavior = smooth ? "smooth" : "auto";
  const searchBox = container.querySelector?.(".wb-table-search-wrap");

  const anchor =
    container.querySelector?.(PRIMARY_RESULT_SELECTOR) ||
    container.querySelector?.(EMPTY_RESULT_SELECTOR) ||
    container.querySelector?.(FALLBACK_RESULT_SELECTOR) ||
    searchBox;

  if (!anchor) {
    if (!(Number(container.scrollTop) || 0)) return false;
    scrollToTop(container, 0, behavior);
    return true;
  }

  const containerRect = container.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  const searchBoxRect = searchBox?.getBoundingClientRect?.() || null;
  const searchBottom = isSearchBoxInView(container, searchBox)
    ? Number(searchBoxRect?.bottom) || Number(containerRect.top) || 0
    : (Number(containerRect.top) || 0) + elementHeight(searchBox);
  const targetViewportTop = searchBottom + RESULT_TOP_GAP;
  if (isElementInView(anchor, targetViewportTop, containerRect.bottom)) return false;
  const anchorRect = anchor.getBoundingClientRect?.() || { top: targetViewportTop };
  const currentTop = Number(container.scrollTop) || 0;

  scrollToTop(container, currentTop + (Number(anchorRect.top) || 0) - targetViewportTop, behavior);
  return true;
}

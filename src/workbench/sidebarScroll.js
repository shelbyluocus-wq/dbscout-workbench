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

// 判断粘性搜索框是否已在滚动容器视野内。搜索框固定在当前数据库分支顶部，
// 搜索结果紧随其下，因此只要搜索框可见，结果就天然可见 —— 无需再滚动。
function isSearchBoxInView(container, searchBox) {
  if (!searchBox) return false;
  const containerRect = container.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  const boxRect = searchBox.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  return Number(boxRect.bottom) > Number(containerRect.top) && Number(boxRect.top) < Number(containerRect.bottom);
}

/**
 * 进入搜索态时，惰性地把搜索上下文带回视野。
 *
 * 与旧的「每次按键都瞬间滚动对齐」不同，这里只在必要时滚动、且默认平滑：
 * - 若粘性搜索框已在视野内（用户本就在浏览当前库的表）→ 不滚动，返回 false，
 *   结果就地出现在搜索框下方，视图保持稳定。
 * - 否则平滑滚动，使第一个结果对齐到搜索框正下方，让搜索上下文回到视野。
 *
 * @param {HTMLElement} container 侧栏滚动容器 `.wb-source-tree`
 * @param {{ smooth?: boolean }} [options]
 * @returns {boolean} 是否执行了滚动
 */
export function revealSidebarSearchResults(container, { smooth = true } = {}) {
  if (!container) return false;

  const behavior = smooth ? "smooth" : "auto";
  const searchBox = container.querySelector?.(".wb-table-search-wrap");

  // 常见情况：搜索框（sticky）已可见，结果紧随其下，无需滚动。
  if (isSearchBoxInView(container, searchBox)) return false;

  const anchor =
    container.querySelector?.(PRIMARY_RESULT_SELECTOR) ||
    container.querySelector?.(EMPTY_RESULT_SELECTOR) ||
    container.querySelector?.(FALLBACK_RESULT_SELECTOR) ||
    searchBox;

  if (!anchor) {
    scrollToTop(container, 0, behavior);
    return true;
  }

  const containerRect = container.getBoundingClientRect?.() || { top: 0 };
  const targetViewportTop = (Number(containerRect.top) || 0) + elementHeight(searchBox) + RESULT_TOP_GAP;
  const anchorRect = anchor.getBoundingClientRect?.() || { top: targetViewportTop };
  const currentTop = Number(container.scrollTop) || 0;

  scrollToTop(container, currentTop + (Number(anchorRect.top) || 0) - targetViewportTop, behavior);
  return true;
}

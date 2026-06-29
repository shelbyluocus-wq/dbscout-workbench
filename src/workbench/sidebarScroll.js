const PRIMARY_RESULT_SELECTOR = ".wb-search-result";
const EMPTY_RESULT_SELECTOR = ".wb-tree-empty, .wb-search-hint";
const FALLBACK_RESULT_SELECTOR = ".wb-value-search-progress-wrap, .wb-table-branch > .wb-tree-row.wb-table-item";
const RESULT_TOP_GAP = 4;

function elementHeight(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect?.();
  return Number(element.offsetHeight) || Math.max(0, Number(rect?.bottom) - Number(rect?.top)) || 0;
}

function scrollToTop(container, top) {
  const nextTop = Math.max(0, Math.round(Number(top) || 0));
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top: nextTop, behavior: "auto" });
  } else {
    container.scrollTop = nextTop;
  }
}

export function scrollSidebarSearchResultsToTop(container) {
  if (!container) return false;

  const anchor =
    container.querySelector?.(PRIMARY_RESULT_SELECTOR) ||
    container.querySelector?.(EMPTY_RESULT_SELECTOR) ||
    container.querySelector?.(FALLBACK_RESULT_SELECTOR);

  if (!anchor) {
    scrollToTop(container, 0);
    return true;
  }

  const containerRect = container.getBoundingClientRect?.() || { top: 0 };
  const searchBox = container.querySelector?.(".wb-table-search-wrap");
  const targetViewportTop = (Number(containerRect.top) || 0) + elementHeight(searchBox) + RESULT_TOP_GAP;
  const anchorRect = anchor.getBoundingClientRect?.() || { top: targetViewportTop };
  const currentTop = Number(container.scrollTop) || 0;

  scrollToTop(container, currentTop + (Number(anchorRect.top) || 0) - targetViewportTop);
  return true;
}

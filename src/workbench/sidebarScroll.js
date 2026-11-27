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
 * An optional `margin` adds breathing room only when the row was off-screen,
 * keeping parent connection headers or neighboring rows visible after a jump.
 */
export function revealSidebarNavigationRow(container, row, { behavior = "auto", margin = 0 } = {}) {
  if (!container || !row) return false;
  const containerRect = container.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  const rowRect = row.getBoundingClientRect?.() || { top: 0, bottom: 0 };
  const viewportHeight = Math.max(0, Number(containerRect.bottom) - Number(containerRect.top));
  const rowHeight = Math.max(0, Number(rowRect.bottom) - Number(rowRect.top));
  const clampedMargin = Math.min(
    Math.max(0, Number(margin) || 0),
    Math.max(0, Math.floor((viewportHeight - rowHeight) / 2)),
  );
  let delta = 0;
  if (Number(rowRect.top) < Number(containerRect.top)) {
    delta = Number(rowRect.top) - Number(containerRect.top) - clampedMargin;
  } else if (Number(rowRect.bottom) > Number(containerRect.bottom)) {
    delta = Number(rowRect.bottom) - Number(containerRect.bottom) + clampedMargin;
  }
  if (!delta) return false;
  scrollToTop(container, (Number(container.scrollTop) || 0) + delta, behavior);
  return true;
}

const TREE_ANIMATING_SELECTOR = [
  ".wb-branch-enter-active",
  ".wb-branch-leave-active",
  ".wb-tree-reorder-enter-active",
  ".wb-tree-reorder-leave-active",
  ".wb-tree-reorder-move",
].join(", ");
const FOLLOW_SETTLE_FRAMES = 3;
const FOLLOW_MAX_DURATION = 1500;
const FOLLOW_USER_SCROLL_EVENTS = ["wheel", "touchmove"];

function isLaidOut(container) {
  const rect = container?.getBoundingClientRect?.();
  return !!rect && Number(rect.bottom) - Number(rect.top) > 0;
}

function isTreeAnimating(container) {
  return !!container?.querySelector?.(TREE_ANIMATING_SELECTOR);
}

function onUserScroll(container, listener) {
  if (typeof container?.addEventListener !== "function") return () => {};
  for (const type of FOLLOW_USER_SCROLL_EVENTS) container.addEventListener(type, listener, { passive: true });
  return () => {
    for (const type of FOLLOW_USER_SCROLL_EVENTS) container.removeEventListener(type, listener);
  };
}

/**
 * Keeps a navigation row revealed until the tree around it stops moving.
 *
 * Changing the source closes one branch and opens another over many frames,
 * so one measurement taken right after the change describes a layout that is
 * gone once those branches settle: the row a single reveal put on screen can
 * end up far outside it. The follower repeats the nearest-edge reveal every
 * frame until the row has held its place and no branch is animating, and
 * lets go as soon as the user scrolls.
 *
 * A hidden container cannot be measured; the request is kept and `resume()`
 * carries it out once the container is shown.
 */
export function createSidebarRowFollower({
  getContainer,
  getRow,
  isAnimating = isTreeAnimating,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  now = () => globalThis.performance.now(),
  settleFrames = FOLLOW_SETTLE_FRAMES,
  maxDuration = FOLLOW_MAX_DURATION,
} = {}) {
  let frame = null;
  let releaseUserScroll = null;
  let waiting = false;
  let pendingOptions = null;

  function end() {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    releaseUserScroll?.();
    releaseUserScroll = null;
  }

  function stop() {
    waiting = false;
    pendingOptions = null;
    end();
  }

  function follow(options = {}) {
    end();
    pendingOptions = options || {};
    const container = getContainer();
    const resolveRow = typeof pendingOptions.getRow === "function" ? pendingOptions.getRow : getRow;
    const anchorOffset = Number.isFinite(pendingOptions.anchorViewportOffset)
      ? Number(pendingOptions.anchorViewportOffset)
      : null;
    const margin = Number.isFinite(pendingOptions.margin) ? Math.max(0, Number(pendingOptions.margin)) : 0;
    const onUserAbort = typeof pendingOptions.onUserScroll === "function" ? pendingOptions.onUserScroll : null;
    const onRowFound = typeof pendingOptions.onRowFound === "function" ? pendingOptions.onRowFound : null;

    waiting = !isLaidOut(container);
    if (waiting) return false;

    const startedAt = now();
    let settled = 0;
    let rowSeen = false;
    // Where the row was when it last moved. Comparing against this rather than
    // the previous frame keeps the slow tail of an easing curve, a fraction of
    // a pixel per frame, from passing for a row at rest.
    let restingOffset = null;
    releaseUserScroll = onUserScroll(container, () => {
      stop();
      onUserAbort?.();
    });

    const step = () => {
      frame = null;
      const containerRect = container?.getBoundingClientRect?.();
      const viewportHeight = containerRect
        ? Math.max(0, Number(containerRect.bottom) - Number(containerRect.top))
        : 0;
      if (!viewportHeight) {
        waiting = true;
        end();
        return;
      }
      const row = resolveRow();
      let offset = null;
      if (row) {
        if (!rowSeen) {
          rowSeen = true;
          onRowFound?.();
        }
        // Single DOM read pass + at most one scroll write to avoid forced
        // read-write-read layout thrashing while branches animate.
        const rowRect = row.getBoundingClientRect?.() || { top: 0, bottom: 0 };
        const currentScrollTop = Number(container.scrollTop) || 0;
        const rowTopInView = Number(rowRect.top) - Number(containerRect.top);
        const rowBottomInView = Number(rowRect.bottom) - Number(containerRect.top);
        const rowHeight = Math.max(0, rowBottomInView - rowTopInView);
        offset = rowTopInView + currentScrollTop;

        let nextScrollTop = currentScrollTop;
        if (anchorOffset !== null) {
          const desiredTop = Math.max(0, offset - anchorOffset);
          if (Math.abs(desiredTop - currentScrollTop) >= 0.5) {
            nextScrollTop = desiredTop;
          }
        }
        const projectedTop = offset - nextScrollTop;
        const projectedBottom = projectedTop + rowHeight;
        const clampedMargin = anchorOffset === null && margin > 0
          ? Math.min(margin, Math.max(0, Math.floor((viewportHeight - rowHeight) / 2)))
          : 0;
        if (projectedTop < 0) {
          nextScrollTop = Math.max(0, offset - clampedMargin);
        } else if (projectedBottom > viewportHeight) {
          nextScrollTop = Math.max(0, offset + rowHeight - viewportHeight + clampedMargin);
        }
        if (Math.abs(nextScrollTop - currentScrollTop) >= 0.5) {
          scrollToTop(container, nextScrollTop, "auto");
        }
      }
      if (offset !== null && restingOffset !== null && Math.abs(offset - restingOffset) < 0.5) {
        settled += 1;
      } else {
        settled = 0;
        restingOffset = offset;
      }
      const atRest = settled >= settleFrames && !isAnimating(container);
      if (atRest || now() - startedAt >= maxDuration) {
        if (atRest) pendingOptions = null;
        end();
      } else {
        frame = requestFrame(step);
      }
    };
    step();
    return true;
  }

  function resume() {
    return waiting ? follow(pendingOptions || {}) : false;
  }

  return { follow, resume, stop };
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

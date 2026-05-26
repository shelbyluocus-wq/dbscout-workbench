import { nextTick, onBeforeUnmount, onMounted } from "vue";

const SCROLLABLE_SELECTOR = [
  ".wb-import-wizard",
  ".wb-import-preview-wrap",
  ".wb-import-mapping-wrap",
  ".wb-data-search-results",
  ".wb-tree",
  ".wb-object-tabs",
  ".wb-grid-wrap",
  ".wb-schema-list",
  ".wb-detail-input",
].join(",");

export function usePersistentScrollbars(rootRef) {
  let observer;
  let resizeObserver;
  let frame = 0;
  const tracked = new Map();

  function updateScrollbar(element, bar, axis) {
    const isHorizontal = axis === "x";
    const style = getComputedStyle(element);
    const overflow = isHorizontal ? style.overflowX : style.overflowY;
    const canScroll = overflow === "auto" || overflow === "scroll";
    const scrollSize = isHorizontal ? element.scrollWidth : element.scrollHeight;
    const clientSize = isHorizontal ? element.clientWidth : element.clientHeight;
    const scrollOffset = isHorizontal ? element.scrollLeft : element.scrollTop;
    const hasOverflow = canScroll && scrollSize > clientSize + 1;

    bar.hidden = !hasOverflow;
    if (!hasOverflow) return;

    const rect = element.getBoundingClientRect();
    const ratio = clientSize / scrollSize;
    const length = Math.max(24, clientSize * ratio);
    const maxOffset = clientSize - length;
    const offset = scrollSize === clientSize ? 0 : (scrollOffset / (scrollSize - clientSize)) * maxOffset;

    if (isHorizontal) {
      bar.style.width = `${length}px`;
      bar.style.height = "var(--wb-scrollbar-size)";
      bar.style.left = `${rect.left + offset}px`;
      bar.style.top = `${rect.bottom - 8}px`;
    } else {
      bar.style.width = "var(--wb-scrollbar-size)";
      bar.style.height = `${length}px`;
      bar.style.left = `${rect.right - 8}px`;
      bar.style.top = `${rect.top + offset}px`;
    }
  }

  function updateElement(element) {
    const entry = tracked.get(element);
    if (!entry) return;
    updateScrollbar(element, entry.x, "x");
    updateScrollbar(element, entry.y, "y");
  }

  function scheduleUpdate() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      tracked.forEach((_, element) => updateElement(element));
    });
  }

  function ensureElement(element) {
    if (tracked.has(element)) return;

    const vertical = document.createElement("div");
    vertical.className = "wb-scrollbar-indicator wb-scrollbar-indicator--y";
    vertical.setAttribute("aria-hidden", "true");

    const horizontal = document.createElement("div");
    horizontal.className = "wb-scrollbar-indicator wb-scrollbar-indicator--x";
    horizontal.setAttribute("aria-hidden", "true");

    rootRef.value.append(vertical, horizontal);

    const onScroll = () => updateElement(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    tracked.set(element, { x: horizontal, y: vertical, onScroll });
    resizeObserver?.observe(element);
    updateElement(element);
  }

  function scan() {
    rootRef.value?.querySelectorAll(SCROLLABLE_SELECTOR).forEach(ensureElement);
    scheduleUpdate();
  }

  onMounted(() => {
    resizeObserver = new ResizeObserver(scheduleUpdate);
    observer = new MutationObserver(() => nextTick(scan));
    if (rootRef.value) {
      observer.observe(rootRef.value, { childList: true, subtree: true });
    }
    window.addEventListener("resize", scheduleUpdate);
    nextTick(scan);
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("resize", scheduleUpdate);
    tracked.forEach((entry, element) => {
      element.removeEventListener("scroll", entry.onScroll);
      entry.x.remove();
      entry.y.remove();
    });
    tracked.clear();
  });
}

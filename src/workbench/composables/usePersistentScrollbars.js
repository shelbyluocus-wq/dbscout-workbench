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
  let scanFrame = 0;
  const updateFrames = new Map();
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

  function removeElement(element) {
    const entry = tracked.get(element);
    if (!entry) return;
    element.removeEventListener("scroll", entry.onScroll);
    element.classList.remove("wb-hide-scrollbar");
    resizeObserver?.unobserve(element);
    entry.x.remove();
    entry.y.remove();
    tracked.delete(element);
    const frame = updateFrames.get(element);
    if (frame) cancelAnimationFrame(frame);
    updateFrames.delete(element);
  }

  function scheduleElementUpdate(element) {
    if (!tracked.has(element) || updateFrames.has(element)) return;
    const frame = requestAnimationFrame(() => {
      updateFrames.delete(element);
      if (rootRef.value && rootRef.value.contains(element)) updateElement(element);
      else removeElement(element);
    });
    updateFrames.set(element, frame);
  }

  function hideAll() {
    tracked.forEach((entry) => {
      entry.x.hidden = true;
      entry.y.hidden = true;
    });
  }

  function scheduleUpdate() {
    tracked.forEach((_, element) => scheduleElementUpdate(element));
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

    element.classList.add("wb-hide-scrollbar");

    const onScroll = () => scheduleElementUpdate(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    tracked.set(element, { x: horizontal, y: vertical, onScroll });
    resizeObserver?.observe(element);
    updateElement(element);
  }

  function scan() {
    const root = rootRef.value;
    if (!root) return;
    tracked.forEach((_, element) => {
      if (!root.contains(element)) removeElement(element);
    });
    root.querySelectorAll(SCROLLABLE_SELECTOR).forEach(ensureElement);
    scheduleUpdate();
  }

  function scheduleScan() {
    if (scanFrame) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = 0;
      nextTick(scan);
    });
  }

  onMounted(() => {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) scheduleElementUpdate(entry.target);
    });
    observer = new MutationObserver(scheduleScan);
    if (rootRef.value) {
      observer.observe(rootRef.value, { childList: true, subtree: true });
    }
    window.addEventListener("resize", () => {
      hideAll();
      scheduleUpdate();
    });
    nextTick(scan);
  });

  onBeforeUnmount(() => {
    if (scanFrame) cancelAnimationFrame(scanFrame);
    updateFrames.forEach((frame) => cancelAnimationFrame(frame));
    updateFrames.clear();
    observer?.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("resize", scheduleUpdate);
    tracked.forEach((_, element) => removeElement(element));
    tracked.clear();
  });
}

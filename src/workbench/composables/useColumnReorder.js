import { getCurrentInstance, onBeforeUnmount, ref } from "vue";
import { ROW_INDEX_WIDTH } from "../constants.js";
import {
  COLUMN_REORDER_THRESHOLD_PX,
  columnReorderExceededThreshold,
  columnReorderScrollDelta,
  resolveColumnDropFromPoint,
  shouldIgnoreColumnReorderPointer,
} from "../utils/columnOrder.js";

function headerRectsFromWrap(wrap) {
  const headers = wrap?.querySelectorAll?.(".wb-grid-column-header-row th[data-column-index]");
  return [...(headers || [])].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      index: Number(element.dataset.columnIndex),
      name: element.dataset.columnName || "",
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
}

export function useColumnReorder({
  getFrozenCount = () => 0,
  getGridWrap = () => null,
  onCommit = () => {},
} = {}) {
  const dragging = ref(false);
  const sourceIndex = ref(-1);
  const sourceName = ref("");
  const drop = ref(null);
  const ghost = ref(null);

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startIndex = -1;
  let startName = "";
  let startWidth = 120;
  let headerRects = [];
  let scrollFrame = 0;

  function listenerTarget() {
    return globalThis.window || null;
  }

  function clearListeners() {
    const target = listenerTarget();
    if (!target) return;
    target.removeEventListener("pointermove", onPointerMove);
    target.removeEventListener("pointerup", onPointerUp);
    target.removeEventListener("pointercancel", onPointerUp);
    target.removeEventListener("keydown", onKeyDown);
  }

  function stopScroll() {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  function reset() {
    clearListeners();
    stopScroll();
    dragging.value = false;
    sourceIndex.value = -1;
    sourceName.value = "";
    drop.value = null;
    ghost.value = null;
    pointerId = null;
    startIndex = -1;
    startName = "";
    headerRects = [];
  }

  function refreshHeaders() {
    headerRects = headerRectsFromWrap(getGridWrap());
  }

  function updateDrop(clientX) {
    drop.value = resolveColumnDropFromPoint(headerRects, clientX, {
      sourceIndex: startIndex,
      frozenCount: getFrozenCount(),
    });
  }

  function updateGhost(clientX, clientY) {
    ghost.value = {
      x: clientX,
      y: clientY,
      width: startWidth,
      label: startName,
    };
  }

  function autoScroll(clientX) {
    const wrap = getGridWrap();
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const frozenCount = getFrozenCount();
    const firstScrollable = headerRects.find((header) => header.index === frozenCount);
    const frozenRight = frozenCount > 0
      ? (firstScrollable?.left ?? rect.left + ROW_INDEX_WIDTH)
      : rect.left + ROW_INDEX_WIDTH;
    const delta = columnReorderScrollDelta({
      clientX,
      wrapLeft: rect.left,
      wrapRight: rect.right,
      frozenRight,
      sourceIndex: startIndex,
      frozenCount,
    });
    if (!delta) {
      stopScroll();
      return;
    }
    wrap.scrollLeft += delta;
    refreshHeaders();
    updateDrop(clientX);
    if (!scrollFrame) {
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (dragging.value) autoScroll(clientX);
      });
    }
  }

  function onPointerMove(event) {
    if (pointerId != null && event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragging.value) {
      if (!columnReorderExceededThreshold(dx, dy, COLUMN_REORDER_THRESHOLD_PX)) return;
      dragging.value = true;
      sourceIndex.value = startIndex;
      sourceName.value = startName;
      refreshHeaders();
    }
    updateGhost(event.clientX, event.clientY);
    updateDrop(event.clientX);
    autoScroll(event.clientX);
  }

  function onPointerUp(event) {
    if (pointerId != null && event.pointerId !== pointerId) return;
    const currentDrop = drop.value;
    const name = startName;
    const wasDragging = dragging.value;
    const target = headerRects.find((header) => header.index === currentDrop?.targetIndex);
    reset();
    if (!wasDragging || !currentDrop?.allowed || !target?.name || target.name === name) return;
    onCommit({
      sourceName: name,
      targetName: target.name,
      position: currentDrop.position,
    });
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      reset();
    }
  }

  function onHeaderPointerDown(event, columnIndex, columnNameValue, headerWidth) {
    if (shouldIgnoreColumnReorderPointer(event)) return false;
    startX = event.clientX;
    startY = event.clientY;
    startIndex = columnIndex;
    startName = columnNameValue;
    startWidth = Number(headerWidth) || 120;
    pointerId = event.pointerId;
    refreshHeaders();
    const target = listenerTarget();
    if (target) {
      target.addEventListener("pointermove", onPointerMove);
      target.addEventListener("pointerup", onPointerUp);
      target.addEventListener("pointercancel", onPointerUp);
      target.addEventListener("keydown", onKeyDown);
    }
    return true;
  }

  if (getCurrentInstance()) onBeforeUnmount(reset);

  return {
    dragging,
    sourceIndex,
    sourceName,
    drop,
    ghost,
    onHeaderPointerDown,
    cancel: reset,
  };
}

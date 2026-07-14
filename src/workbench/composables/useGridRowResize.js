import { computed, onBeforeUnmount } from "vue";
import { GRID_FIELD_COMMENT_HEIGHT, GRID_ROW_HEIGHT } from "../constants.js";
import {
  clampFieldCommentHeight,
  clampGridRowHeight,
  resolveFieldCommentHeight,
  resolveGridRowHeight,
} from "../utils/gridRowHeight.js";

export function useGridRowResize(activeTab) {
  const rowHeight = computed(() => resolveGridRowHeight(activeTab.value));
  const fieldCommentHeight = computed(() => resolveFieldCommentHeight(activeTab.value));
  let finishActiveResize = null;

  function resetRowHeight(kind = "data") {
    const tab = activeTab.value;
    if (!tab) return;
    if (kind === "fieldComment") tab.fieldCommentHeight = GRID_FIELD_COMMENT_HEIGHT;
    else tab.rowHeight = GRID_ROW_HEIGHT;
  }

  function startRowResize(event, kind = "data") {
    if (!activeTab.value || (event?.button != null && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    finishActiveResize?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const property = kind === "fieldComment" ? "fieldCommentHeight" : "rowHeight";
    const startHeight = kind === "fieldComment" ? fieldCommentHeight.value : rowHeight.value;
    const clamp = kind === "fieldComment" ? clampFieldCommentHeight : clampGridRowHeight;
    const cursor = "row-resize";

    target?.setPointerCapture?.(pointerId);
    if (globalThis.document?.body?.style) {
      globalThis.document.body.style.cursor = cursor;
      globalThis.document.body.style.userSelect = "none";
    }

    const onMove = (moveEvent) => {
      const samples = moveEvent.getCoalescedEvents?.();
      const latest = samples?.length ? samples[samples.length - 1] : moveEvent;
      const tab = activeTab.value;
      if (!tab) return;
      tab[property] = clamp(startHeight + latest.clientY - startY);
    };

    const finish = () => {
      globalThis.removeEventListener?.("pointermove", onMove);
      globalThis.removeEventListener?.("pointerup", finish);
      globalThis.removeEventListener?.("pointercancel", finish);
      target?.removeEventListener?.("lostpointercapture", finish);
      if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      if (globalThis.document?.body?.style) {
        globalThis.document.body.style.cursor = "";
        globalThis.document.body.style.userSelect = "";
      }
      if (finishActiveResize === finish) finishActiveResize = null;
    };

    finishActiveResize = finish;
    globalThis.addEventListener?.("pointermove", onMove);
    globalThis.addEventListener?.("pointerup", finish);
    globalThis.addEventListener?.("pointercancel", finish);
    target?.addEventListener?.("lostpointercapture", finish);
  }

  onBeforeUnmount(() => finishActiveResize?.());

  return {
    rowHeight,
    fieldCommentHeight,
    startRowResize,
    resetRowHeight,
  };
}

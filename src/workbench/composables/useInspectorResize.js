import { computed, getCurrentInstance, onBeforeUnmount, ref } from "vue";

const DETAIL_DEFAULT_HEIGHT = 212;
const DETAIL_MIN_HEIGHT = 126;
const SCHEMA_MIN_HEIGHT = 112;
const FIXED_INSPECTOR_HEIGHT = 46;
const KEYBOARD_STEP = 12;

export function useInspectorResize() {
  const inspectorRef = ref(null);
  const detailHeight = ref(DETAIL_DEFAULT_HEIGHT);
  const isDetailResizing = ref(false);
  let removeDragListeners = null;

  const detailPanelStyle = computed(() => ({
    height: `${detailHeight.value}px`,
  }));

  function maxDetailHeight() {
    const height = inspectorRef.value?.getBoundingClientRect?.().height;
    if (!Number.isFinite(height) || height <= 0) return DETAIL_DEFAULT_HEIGHT;
    return Math.max(
      DETAIL_MIN_HEIGHT,
      Math.floor(height - SCHEMA_MIN_HEIGHT - FIXED_INSPECTOR_HEIGHT),
    );
  }

  function clampDetailHeight(height) {
    return Math.max(
      DETAIL_MIN_HEIGHT,
      Math.min(maxDetailHeight(), Math.round(height)),
    );
  }

  function finishDetailResize() {
    removeDragListeners?.();
    removeDragListeners = null;
    isDetailResizing.value = false;
    if (globalThis.document?.body?.style) {
      globalThis.document.body.style.cursor = "";
      globalThis.document.body.style.userSelect = "";
    }
  }

  function onDetailDividerMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    finishDetailResize();

    const startY = event.clientY;
    const startHeight = clampDetailHeight(detailHeight.value);
    detailHeight.value = startHeight;
    isDetailResizing.value = true;

    if (globalThis.document?.body?.style) {
      globalThis.document.body.style.cursor = "row-resize";
      globalThis.document.body.style.userSelect = "none";
    }

    const onMove = (moveEvent) => {
      detailHeight.value = clampDetailHeight(
        startHeight + startY - moveEvent.clientY,
      );
    };
    const onUp = () => finishDetailResize();

    globalThis.window?.addEventListener("mousemove", onMove);
    globalThis.window?.addEventListener("mouseup", onUp);
    removeDragListeners = () => {
      globalThis.window?.removeEventListener("mousemove", onMove);
      globalThis.window?.removeEventListener("mouseup", onUp);
    };
  }

  function resetDetailHeight() {
    detailHeight.value = clampDetailHeight(DETAIL_DEFAULT_HEIGHT);
  }

  function onDetailDividerKeydown(event) {
    if (event.key === "Home") {
      event.preventDefault();
      resetDetailHeight();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const step = event.shiftKey ? KEYBOARD_STEP * 3 : KEYBOARD_STEP;
    detailHeight.value = clampDetailHeight(detailHeight.value + direction * step);
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(finishDetailResize);
  }

  return {
    inspectorRef,
    detailPanelStyle,
    isDetailResizing,
    onDetailDividerMouseDown,
    onDetailDividerKeydown,
    resetDetailHeight,
  };
}

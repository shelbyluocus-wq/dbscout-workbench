import { onUnmounted } from "vue";

/**
 * Low-level tab-bar window-drag helper. Tracks left-button mousedown on the
 * tab-bar (including .wb-tab elements) and calls startDragMove once the pointer
 * moves past a 4px threshold.
 *
 * Interactive controls such as the tab close button are still ignored so they
 * keep their native behaviour.
 *
 * When the press starts on a draggable tab element, its HTML5 drag is briefly
 * suspended for the lifetime of the gesture so it does not swallow the mouse
 * events required by Tauri's programmatic window drag.
 *
 * @param {() => void} startDragMove
 * @returns {{
 *   onTabBarMouseDown: (event: MouseEvent, tabBarEl: HTMLElement) => void,
 *   cleanup: () => void,
 * }}
 */
export function createTabWindowDrag(startDragMove) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let hasFired = false;
  let activeListenerTarget = null;
  let dragDisabledTab = null;
  let originalDraggable = "";

  function restoreTabDraggable() {
    if (!dragDisabledTab) return;
    dragDisabledTab.setAttribute("draggable", originalDraggable);
    dragDisabledTab = null;
    originalDraggable = "";
  }

  function cleanup() {
    restoreTabDraggable();
    if (!activeListenerTarget) return;
    activeListenerTarget.removeEventListener("mousemove", onMouseMove);
    activeListenerTarget.removeEventListener("mouseup", onMouseUp);
    activeListenerTarget = null;
    isDragging = false;
    hasFired = false;
  }

  function onMouseMove(event) {
    if (!isDragging || hasFired) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.sqrt(dx * dx + dy * dy) > 4) {
      hasFired = true;
      // Restore draggable before the window drag takes over so the tab element
      // is left in its normal state once the mouse is released.
      restoreTabDraggable();
      startDragMove();
    }
  }

  function onMouseUp() {
    cleanup();
  }

  function onTabBarMouseDown(event, tabBarEl) {
    // Only left mouse button
    if (event.button !== 0) return;

    const target = event.target;

    // Ignore interactive controls so clicks keep working
    if (
      target?.closest?.(".wb-tab-close") ||
      target?.closest?.('button:not(.wb-tab), [role="button"]:not(.wb-tab), input, textarea, select, a, menu')
    ) {
      return;
    }

    cleanup();
    isDragging = true;
    hasFired = false;
    startX = event.clientX;
    startY = event.clientY;

    // If the press starts on a draggable tab, suspend its native drag so the
    // document mousemove events required by startDragMove are not suppressed.
    const tabEl = target?.closest?.(".wb-tab");
    if (tabEl && tabEl.getAttribute("draggable") === "true") {
      dragDisabledTab = tabEl;
      originalDraggable = tabEl.getAttribute("draggable") || "true";
      tabEl.setAttribute("draggable", "false");
    }

    // Listen on the document so dragging still works when the cursor leaves the
    // tab-bar.
    activeListenerTarget = tabBarEl.ownerDocument || tabBarEl;

    activeListenerTarget.addEventListener("mousemove", onMouseMove);
    activeListenerTarget.addEventListener("mouseup", onMouseUp);
  }

  return { onTabBarMouseDown, cleanup };
}

/**
 * Vue composable wrapper for tab-bar window-drag.
 * Automatically cleans up listeners on component unmount.
 *
 * @param {() => void} startDragMove
 * @returns {{ onTabBarMouseDown: (event: MouseEvent, tabBarEl: HTMLElement) => void }}
 */
export function useTabWindowDrag(startDragMove) {
  const { onTabBarMouseDown, cleanup } = createTabWindowDrag(startDragMove);
  onUnmounted(cleanup);
  return { onTabBarMouseDown };
}

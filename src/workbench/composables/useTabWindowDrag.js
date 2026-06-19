import { onUnmounted } from "vue";

/**
 * Low-level tab-bar window-drag helper. Tracks left-button mousedown on the
 * tab-bar background and calls startDragMove once the pointer moves past a 4px
 * threshold.
 *
 * Tabs and interactive controls are ignored so tab reordering, tab activation,
 * and close controls keep priority over programmatic window dragging.
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

  function cleanup() {
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
      target?.closest?.(".wb-tab") ||
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

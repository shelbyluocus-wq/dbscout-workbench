import { onUnmounted } from "vue";

/**
 * Low-level tab-bar window-drag helper. Tracks mousedown on the tab-bar
 * background (ignoring .wb-tab elements) and calls startDragMove once
 * the pointer moves past a 4px threshold.
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
  let activeTabBarEl = null;

  function cleanup() {
    if (!activeTabBarEl) return;
    activeTabBarEl.removeEventListener("mousemove", onMouseMove);
    activeTabBarEl.removeEventListener("mouseup", onMouseUp);
    activeTabBarEl.removeEventListener("mouseleave", onMouseUp);
    activeTabBarEl = null;
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

    // Ignore clicks on .wb-tab elements or their descendants
    const target = event.target;
    if (
      target?.classList?.contains("wb-tab") ||
      target?.closest?.(".wb-tab")
    ) {
      return;
    }

    cleanup();
    isDragging = true;
    hasFired = false;
    startX = event.clientX;
    startY = event.clientY;
    activeTabBarEl = tabBarEl;

    tabBarEl.addEventListener("mousemove", onMouseMove);
    tabBarEl.addEventListener("mouseup", onMouseUp);
    tabBarEl.addEventListener("mouseleave", onMouseUp);
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

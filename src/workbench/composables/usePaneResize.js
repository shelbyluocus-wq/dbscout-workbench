import { computed, ref } from "vue";

const SIDEBAR_DEFAULT = 292;
const SIDEBAR_MIN = 260;
const INSPECTOR_DEFAULT = 322;
const INSPECTOR_MIN = 200;
const MAIN_MIN = 400;
const DIVIDER_WIDTH = 4;
const PADDING = 16;
const PANE_COLLAPSE_ANIMATION_MS = 280;
export const SIDEBAR_TITLEBAR_COLLAPSED_WIDTH = 32;
export const SIDEBAR_TAB_CLEARANCE_PX = SIDEBAR_TITLEBAR_COLLAPSED_WIDTH;

export function usePaneResize() {
  const workspaceRef = ref(null);
  const isDragging = ref(false);

  const sidebarWidth = ref(SIDEBAR_DEFAULT);
  const inspectorWidth = ref(INSPECTOR_DEFAULT);
  const sidebarCollapsed = ref(false);
  const inspectorCollapsed = ref(false);
  const sidebarPaneAnimating = ref(false);
  const sidebarPanePhase = ref(null);

  let savedSidebarWidth = SIDEBAR_DEFAULT;
  let savedInspectorWidth = INSPECTOR_DEFAULT;
  let sidebarAnimationTimer = null;

  function finishSidebarPaneAnimation() {
    sidebarPaneAnimating.value = false;
    sidebarPanePhase.value = null;
    if (sidebarAnimationTimer) {
      clearTimeout(sidebarAnimationTimer);
      sidebarAnimationTimer = null;
    }
  }

  function beginSidebarPaneAnimation(phase) {
    sidebarPaneAnimating.value = true;
    sidebarPanePhase.value = phase;
    if (sidebarAnimationTimer) {
      clearTimeout(sidebarAnimationTimer);
    }
    sidebarAnimationTimer = setTimeout(() => {
      finishSidebarPaneAnimation();
    }, PANE_COLLAPSE_ANIMATION_MS + 80);
  }

  function collapseSidebar() {
    if (sidebarCollapsed.value || sidebarPaneAnimating.value) {
      return;
    }
    savedSidebarWidth = sidebarWidth.value;
    beginSidebarPaneAnimation("collapsing");
    sidebarCollapsed.value = true;
  }

  function expandSidebar() {
    if (!sidebarCollapsed.value) {
      return;
    }
    beginSidebarPaneAnimation("expanding");
    sidebarCollapsed.value = false;
    sidebarWidth.value = savedSidebarWidth;
  }

  function onSidebarLayoutTransitionEnd(event) {
    if (event?.target !== event?.currentTarget) {
      return;
    }
    if (event?.propertyName !== "--wb-sidebar-slot-width") {
      return;
    }
    if (!sidebarPaneAnimating.value) {
      return;
    }
    finishSidebarPaneAnimation();
  }

  const sidebarLayoutVars = computed(() => ({
    "--wb-sidebar-slot-width": sidebarCollapsed.value
      ? "0px"
      : `${sidebarWidth.value}px`,
    "--wb-sidebar-titlebar-width": sidebarCollapsed.value
      ? `${SIDEBAR_TITLEBAR_COLLAPSED_WIDTH}px`
      : `${sidebarWidth.value}px`,
    // The expanded target width, NEVER gated by the collapsed flag. Used by
    // the expand animation to lock the inner sidebar at its final width so
    // .wb-source-tree (potentially hundreds of rows) doesn't reflow on every
    // animation frame as the slot widens. The slot's `overflow: hidden`
    // reveals the pre-laid-out content as it grows.
    "--wb-sidebar-saved-width": `${sidebarWidth.value}px`,
  }));

  const sidebarSlotStyle = computed(() => ({
    width: sidebarLayoutVars.value["--wb-sidebar-slot-width"],
  }));

  const inspectorStyle = computed(() => {
    if (inspectorCollapsed.value) {
      return { width: "0px", opacity: 0, borderWidth: "0px", padding: "0px" };
    }
    return { width: inspectorWidth.value + "px", opacity: 1 };
  });

  function maxFor(pane) {
    const ws = workspaceRef.value;
    if (!ws) return pane === "sidebar" ? 500 : 500;
    const total = ws.clientWidth - PADDING - DIVIDER_WIDTH * 2;
    const other = pane === "sidebar" ? (inspectorCollapsed.value ? 0 : inspectorWidth.value) : (sidebarCollapsed.value ? 0 : sidebarWidth.value);
    return Math.max(0, total - MAIN_MIN - other);
  }

  function onDividerMouseDown(e, pane) {
    if (e.button !== 0) return;
    if (e.target.closest(".wb-pane-toggle")) return;
    e.preventDefault();

    const ws = workspaceRef.value;
    if (!ws) return;

    const paneEl = pane === "sidebar"
      ? ws.querySelector(".wb-sidebar")
      : ws.querySelector(".wb-inspector");

    if (!paneEl) return;

    const isSidebar = pane === "sidebar";
    const minW = isSidebar ? SIDEBAR_MIN : INSPECTOR_MIN;
    let currentWidth;

    if (isSidebar && sidebarCollapsed.value) {
      expandSidebar();
      currentWidth = savedSidebarWidth;
    } else if (!isSidebar && inspectorCollapsed.value) {
      inspectorCollapsed.value = false;
      inspectorWidth.value = savedInspectorWidth;
      currentWidth = savedInspectorWidth;
    } else {
      currentWidth = Math.round(paneEl.getBoundingClientRect().width);
    }

    const dividerRect = e.currentTarget.getBoundingClientRect();
    const startX = dividerRect.left + dividerRect.width / 2;
    let dragWidth = currentWidth;

    isDragging.value = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    ws.classList.add("is-dragging");

    function onMove(ev) {
      const delta = isSidebar ? (ev.clientX - startX) : (startX - ev.clientX);
      const next = Math.max(minW, Math.min(maxFor(pane), currentWidth + delta));
      dragWidth = next;
      if (isSidebar) sidebarWidth.value = next;
      else inspectorWidth.value = next;
    }

    function onUp() {
      const finalWidth = dragWidth;
      ws.classList.remove("is-dragging");

      if (isSidebar) {
        sidebarWidth.value = finalWidth;
        savedSidebarWidth = finalWidth;
      } else {
        inspectorWidth.value = finalWidth;
        savedInspectorWidth = finalWidth;
      }

      isDragging.value = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function toggleSidebar() {
    if (sidebarCollapsed.value) {
      expandSidebar();
      return;
    }
    collapseSidebar();
  }

  function toggleInspector() {
    if (inspectorCollapsed.value) {
      inspectorWidth.value = savedInspectorWidth;
      inspectorCollapsed.value = false;
    } else {
      savedInspectorWidth = inspectorWidth.value;
      inspectorCollapsed.value = true;
    }
  }

  return {
    workspaceRef,
    isDragging,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed,
    inspectorCollapsed,
    sidebarPaneAnimating,
    sidebarPanePhase,
    sidebarLayoutVars,
    sidebarSlotStyle,
    inspectorStyle,
    onDividerMouseDown,
    onSidebarLayoutTransitionEnd,
    toggleSidebar,
    toggleInspector,
  };
}

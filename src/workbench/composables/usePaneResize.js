import { computed, ref } from "vue";

const SIDEBAR_DEFAULT = 292;
const SIDEBAR_MIN = 260;
const INSPECTOR_DEFAULT = 322;
const INSPECTOR_MIN = 200;
const MAIN_MIN = 400;
const DIVIDER_WIDTH = 4;
const PADDING = 16;

export function usePaneResize() {
  const workspaceRef = ref(null);
  const isDragging = ref(false);

  const sidebarWidth = ref(SIDEBAR_DEFAULT);
  const inspectorWidth = ref(INSPECTOR_DEFAULT);
  const sidebarCollapsed = ref(false);
  const inspectorCollapsed = ref(false);

  let savedSidebarWidth = SIDEBAR_DEFAULT;
  let savedInspectorWidth = INSPECTOR_DEFAULT;

  const sidebarStyle = computed(() => {
    if (sidebarCollapsed.value) {
      return { width: "0px", opacity: 0, borderWidth: "0px", padding: "0px" };
    }
    return { width: sidebarWidth.value + "px", opacity: 1 };
  });

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
      sidebarCollapsed.value = false;
      sidebarWidth.value = savedSidebarWidth;
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

    // Disable transition during drag
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
      sidebarWidth.value = savedSidebarWidth;
      sidebarCollapsed.value = false;
    } else {
      savedSidebarWidth = sidebarWidth.value;
      sidebarCollapsed.value = true;
    }
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
    sidebarStyle,
    inspectorStyle,
    onDividerMouseDown,
    toggleSidebar,
    toggleInspector,
  };
}

import { computed, ref, watch } from "vue";
import {
  isInspectorSpaceTight,
  readInspectorPrefs,
  resolveInspectorCollapsed,
  writeInspectorPrefs,
} from "../inspectorVisibility.js";

const SIDEBAR_DEFAULT = 292;
const SIDEBAR_MIN = 260;
const INSPECTOR_DEFAULT = 322;
export const INSPECTOR_MIN_WIDTH = 288;
const MAIN_MIN = 400;
const DIVIDER_WIDTH = 4;
const PADDING = 16;
const PANE_COLLAPSE_ANIMATION_MS = 280;
// Mirrors --wb-activity-rail-width: the rail always sits left of the sidebar,
// and the titlebar strip above them spans both.
export const ACTIVITY_RAIL_WIDTH = 40;
export const SIDEBAR_TITLEBAR_COLLAPSED_WIDTH = ACTIVITY_RAIL_WIDTH;
export const SIDEBAR_TAB_CLEARANCE_PX = SIDEBAR_TITLEBAR_COLLAPSED_WIDTH;

// 持久化面板宽度与收起状态，重启后恢复用户上次调整的尺寸/状态。
const SIDEBAR_WIDTH_KEY = "dbscout_sidebar_width";
const INSPECTOR_WIDTH_KEY = "dbscout_inspector_width";
const SIDEBAR_COLLAPSED_KEY = "dbscout_sidebar_collapsed";

function clampWidth(value, min, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.round(n);
}

function readStoredWidth(key, min, fallback) {
  try {
    return clampWidth(localStorage.getItem(key), min, fallback);
  } catch {
    return fallback;
  }
}

function writeStoredWidth(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore quota / privacy errors */
  }
}

function readStoredCollapsed(key, defaultValue) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? defaultValue : raw === "1";
  } catch {
    return defaultValue;
  }
}

function writeStoredCollapsed(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore quota / privacy errors */
  }
}

export function usePaneResize({ initialCollapsed = true, viewportWidth = ref(0) } = {}) {
  const workspaceRef = ref(null);
  const isDragging = ref(false);

  const sidebarWidth = ref(readStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN, SIDEBAR_DEFAULT));
  const inspectorWidth = ref(readStoredWidth(INSPECTOR_WIDTH_KEY, INSPECTOR_MIN_WIDTH, INSPECTOR_DEFAULT));
  const sidebarCollapsed = ref(readStoredCollapsed(SIDEBAR_COLLAPSED_KEY, initialCollapsed));
  // 右侧栏开合由「当前页面类型 + 用户偏好 + 空间是否紧张」共同决定，见 inspectorVisibility.js。
  const inspectorSurface = ref("data");
  const inspectorPrefs = ref(readInspectorPrefs());
  const inspectorTightOverrides = ref({});
  // 宽度按默认值封顶参与判断：拖宽侧栏或右侧栏时不会反过来把正在拖的面板自动收起。
  const inspectorSpaceTight = computed(() => isInspectorSpaceTight({
    viewportWidth: viewportWidth.value,
    sidebarSpace: ACTIVITY_RAIL_WIDTH + (sidebarCollapsed.value ? 0 : Math.min(sidebarWidth.value, SIDEBAR_DEFAULT)),
    inspectorWidth: Math.min(Math.max(inspectorWidth.value, INSPECTOR_MIN_WIDTH), INSPECTOR_DEFAULT),
  }));
  watch(inspectorSpaceTight, (tight) => {
    if (!tight) inspectorTightOverrides.value = {};
  });
  const inspectorCollapsed = computed(() => resolveInspectorCollapsed({
    surface: inspectorSurface.value,
    prefs: inspectorPrefs.value,
    tight: inspectorSpaceTight.value,
    tightOverrides: inspectorTightOverrides.value,
  }));
  const sidebarPaneAnimating = ref(false);
  const sidebarPanePhase = ref(null);

  let savedSidebarWidth = sidebarWidth.value;
  let savedInspectorWidth = inspectorWidth.value;
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
    writeStoredCollapsed(SIDEBAR_COLLAPSED_KEY, true);
  }

  function expandSidebar() {
    if (!sidebarCollapsed.value) {
      return;
    }
    beginSidebarPaneAnimation("expanding");
    sidebarCollapsed.value = false;
    sidebarWidth.value = savedSidebarWidth;
    writeStoredCollapsed(SIDEBAR_COLLAPSED_KEY, false);
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
      : `${ACTIVITY_RAIL_WIDTH + sidebarWidth.value}px`,
    "--wb-sidebar-content-width": `${sidebarWidth.value}px`,
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
    const total = ws.clientWidth - ACTIVITY_RAIL_WIDTH - PADDING - DIVIDER_WIDTH * 2;
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
    const minW = isSidebar ? SIDEBAR_MIN : INSPECTOR_MIN_WIDTH;
    let currentWidth;

    if (isSidebar && sidebarCollapsed.value) {
      expandSidebar();
      currentWidth = savedSidebarWidth;
    } else if (!isSidebar && inspectorCollapsed.value) {
      setInspectorCollapsed(false);
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
        writeStoredWidth(SIDEBAR_WIDTH_KEY, finalWidth);
      } else {
        inspectorWidth.value = finalWidth;
        savedInspectorWidth = finalWidth;
        writeStoredWidth(INSPECTOR_WIDTH_KEY, finalWidth);
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

  // 用户手动开合：按当前页面类型记住偏好；空间紧张时同时记一次临时覆盖，避免被自动收起立即抵消。
  function setInspectorCollapsed(collapsed) {
    if (collapsed === inspectorCollapsed.value) return;
    if (collapsed) savedInspectorWidth = inspectorWidth.value;
    else inspectorWidth.value = savedInspectorWidth;
    const surface = inspectorSurface.value;
    inspectorPrefs.value = { ...inspectorPrefs.value, [surface]: collapsed };
    writeInspectorPrefs(inspectorPrefs.value);
    if (inspectorSpaceTight.value) {
      inspectorTightOverrides.value = { ...inspectorTightOverrides.value, [surface]: collapsed };
    }
  }

  function toggleInspector() {
    setInspectorCollapsed(!inspectorCollapsed.value);
  }

  function expandInspector() {
    setInspectorCollapsed(false);
  }

  return {
    workspaceRef,
    isDragging,
    sidebarWidth,
    inspectorWidth,
    sidebarCollapsed,
    inspectorCollapsed,
    inspectorSurface,
    sidebarPaneAnimating,
    sidebarPanePhase,
    sidebarLayoutVars,
    sidebarSlotStyle,
    inspectorStyle,
    onDividerMouseDown,
    onSidebarLayoutTransitionEnd,
    toggleSidebar,
    toggleInspector,
    expandInspector,
  };
}

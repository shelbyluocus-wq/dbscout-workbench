import { ref } from "vue";

import { invokeWorkbench, isTauriRuntime } from "../utils/tauriBridge.js";
import { isMacOSPlatform } from "../utils/desktopPlatform.js";

// Title-bar double-click follows the macOS "AppleActionOnDoubleClick" setting
// ("minimize" | "none" | "zoom"). The value is read once from the backend and
// re-fetched on window focus so a changed system setting is picked up.
const DOUBLE_CLICK_ACTIONS = new Set(["minimize", "none", "zoom"]);
const doubleClickAction = ref("zoom");
let focusRefreshBound = false;

export function isMacosTitlebarManaged() {
  return isTauriRuntime() && isMacOSPlatform();
}

async function refreshDoubleClickAction() {
  try {
    const value = String(await invokeWorkbench("macos_titlebar_double_click_action") || "");
    if (DOUBLE_CLICK_ACTIONS.has(value)) doubleClickAction.value = value;
  } catch {
    // Keep the cached action when the command is unavailable.
  }
}

// Tauri's injected drag-region script toggles maximize on any double-click
// (mousedown records the position on macOS, mouseup fires the toggle), which
// ignores the system setting. Swallow double-click mousedown/mouseup events
// in the capture phase — but only where Tauri itself would act: the bare
// attribute counts only when the event target itself carries it, so double
// clicks on tabs/buttons inside a drag region stay untouched.
function swallowDragRegionDoubleClick(event) {
  if (event?.detail !== 2) return;
  const path = event.composedPath?.() || [];
  for (const el of path) {
    if (typeof el?.hasAttribute !== "function" || !el.hasAttribute("data-tauri-drag-region")) continue;
    const attr = el.getAttribute("data-tauri-drag-region");
    if (attr === "false") return;
    if (attr === "deep" || el === path[0]) {
      event.stopPropagation();
      return;
    }
    return;
  }
}

export function useMacosTitlebarDoubleClick() {
  const managed = isMacosTitlebarManaged();

  function bind() {
    if (!managed || focusRefreshBound) return;
    focusRefreshBound = true;
    globalThis.window?.addEventListener?.("focus", refreshDoubleClickAction);
    globalThis.document?.addEventListener?.("mousedown", swallowDragRegionDoubleClick, true);
    globalThis.document?.addEventListener?.("mouseup", swallowDragRegionDoubleClick, true);
    void refreshDoubleClickAction();
  }

  // Apply the setting: "minimize" minimizes, "none" does nothing, anything
  // else zooms (toggleMaximize).
  function runDoubleClickAction({ minimize, zoom }) {
    const action = doubleClickAction.value;
    if (action === "minimize") return void minimize?.();
    if (action === "zoom") return void zoom?.();
  }

  bind();
  return { managed, doubleClickAction, runDoubleClickAction, refresh: refreshDoubleClickAction };
}

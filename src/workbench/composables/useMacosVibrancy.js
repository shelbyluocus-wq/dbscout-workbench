import { ref } from "vue";

import { isTauriRuntime } from "../utils/tauriBridge.js";
import { isMacOSPlatform } from "../utils/desktopPlatform.js";

// macOS window vibrancy (NSVisualEffectView "sidebar" material) behind the
// activity rail + sidebar. Only meaningful in a native macOS Tauri runtime;
// everywhere else this stays off and is a no-op.
export const VIBRANCY_STORAGE_KEY = "dbscout_macos_vibrancy";

const vibrancy = ref(false);
let applied = false;

export function isVibrancySupported() {
  return isTauriRuntime() && isMacOSPlatform();
}

function readPreference() {
  try {
    // Default ON; anything but an explicit "0" counts as enabled.
    return globalThis.localStorage?.getItem(VIBRANCY_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

async function applyEffects(on) {
  const { getCurrentWindow, Effect, EffectState } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (on) {
    await win.setEffects({
      effects: [Effect.Sidebar],
      state: EffectState.FollowsWindowActiveState,
    });
  } else {
    await win.clearEffects();
  }
}

function setRootBackground(transparent) {
  const bg = transparent ? "transparent" : "";
  const root = globalThis.document?.documentElement;
  const body = globalThis.document?.body;
  if (root?.style) root.style.backgroundColor = bg;
  if (body?.style) body.style.backgroundColor = bg;
}

async function setVibrancy(on) {
  const next = Boolean(on) && isVibrancySupported();
  if (vibrancy.value === next && applied) return;
  applied = true;
  if (next) {
    try {
      await applyEffects(true);
    } catch (error) {
      // Native blur unavailable — stay fully opaque instead of showing the
      // desktop sharply through translucent surfaces.
      console.error("[useMacosVibrancy] setEffects failed:", error);
      vibrancy.value = false;
      document.documentElement.classList.remove("is-vibrancy");
      setRootBackground(false);
      refreshTheme?.();
      return;
    }
    vibrancy.value = true;
    document.documentElement.classList.add("is-vibrancy");
    setRootBackground(true);
  } else {
    vibrancy.value = false;
    document.documentElement.classList.remove("is-vibrancy");
    setRootBackground(false);
    if (isVibrancySupported()) {
      try {
        await applyEffects(false);
      } catch (error) {
        console.error("[useMacosVibrancy] clearEffects failed:", error);
      }
    }
  }
  refreshTheme?.();
}

// The theme controller owns the html/body inline background; when vibrancy
// flips we ask it to re-apply so the background follows the mode.
let refreshTheme = null;

export function useMacosVibrancy({ themeRefresh = null } = {}) {
  refreshTheme = themeRefresh;
  function start() {
    void setVibrancy(readPreference());
  }

  function setPreference(on) {
    try {
      globalThis.localStorage?.setItem(VIBRANCY_STORAGE_KEY, on ? "1" : "0");
    } catch {
      // Persistence blocked — the session still applies it.
    }
    void setVibrancy(on);
  }

  return { vibrancy, start, setPreference, supported: isVibrancySupported() };
}

import { ref } from "vue";

import { isTauriRuntime } from "../utils/tauriBridge.js";

async function resolveCurrentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

function errorMessage(error) {
  return String(error?.message || error || "未知错误");
}

export function useWindowPin({
  runtimeAvailable = isTauriRuntime,
  getWindow = resolveCurrentWindow,
} = {}) {
  const pinned = ref(false);
  const pending = ref(false);
  const error = ref("");

  async function sync() {
    if (!runtimeAvailable()) return { ok: true, pinned: pinned.value, simulated: true };
    if (pending.value) return { ok: false, busy: true, pinned: pinned.value };
    pending.value = true;
    try {
      const window = await getWindow();
      if (typeof window?.isAlwaysOnTop !== "function") return { ok: true, pinned: pinned.value };
      pinned.value = Boolean(await window.isAlwaysOnTop());
      error.value = "";
      return { ok: true, pinned: pinned.value };
    } catch (cause) {
      error.value = errorMessage(cause);
      return { ok: false, pinned: pinned.value, error: error.value };
    } finally {
      pending.value = false;
    }
  }

  async function setPinned(nextValue) {
    if (pending.value) return { ok: false, busy: true, pinned: pinned.value };

    const nextPinned = Boolean(nextValue);
    const nativeRuntime = runtimeAvailable();
    pending.value = true;
    error.value = "";
    try {
      if (nativeRuntime) {
        const window = await getWindow();
        if (typeof window?.setAlwaysOnTop !== "function") {
          throw new Error("当前窗口不支持置顶");
        }
        await window.setAlwaysOnTop(nextPinned);
      }
      pinned.value = nextPinned;
      return {
        ok: true,
        pinned: pinned.value,
        simulated: !nativeRuntime,
      };
    } catch (cause) {
      error.value = errorMessage(cause);
      return { ok: false, pinned: pinned.value, error: error.value };
    } finally {
      pending.value = false;
    }
  }

  function toggle() {
    return setPinned(!pinned.value);
  }

  return {
    pinned,
    pending,
    error,
    sync,
    setPinned,
    toggle,
  };
}

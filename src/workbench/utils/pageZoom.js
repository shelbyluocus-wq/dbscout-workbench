export const PAGE_ZOOM_MIN = 0.5;
export const PAGE_ZOOM_MAX = 2;
export const PAGE_ZOOM_STORAGE_KEY = "dbscout.page-zoom.v1";

export function pageZoomAction(event, platform) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  if (platform === "macos" ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return null;
  if (["+", "="].includes(event.key) || event.code === "NumpadAdd") return "zoomIn";
  if (event.key === "-" || event.code === "NumpadSubtract") return "zoomOut";
  if (!event.shiftKey && (event.key === "0" || event.code === "Numpad0")) return "zoomReset";
  return null;
}

export function createPageZoomWheelHandler({ platform, run, enabled = () => true, now = () => performance.now() }) {
  let accumulated = 0;
  let lastTime = -Infinity;
  return (event) => {
    const modifier = platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!enabled() || !modifier || event.altKey || event.shiftKey || event.defaultPrevented
      || !Number.isFinite(event.deltaY) || !event.deltaY || event.cancelable === false
      || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY)
      || event.target?.closest?.('.wb-relation-graph-canvas, .wb-relation-graph-surface, [data-wb-shortcut-capture="true"]')) {
      accumulated = 0;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const time = now();
    const delta = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 80 : 1);
    if (time - lastTime > 200 || Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    lastTime = time;
    accumulated += delta;
    if (Math.abs(accumulated) < 80) return;
    accumulated = 0;
    void run(delta < 0 ? "zoomIn" : "zoomOut");
  };
}

export function createPageZoom({ applyZoom, onChange = () => {}, onError = () => {}, getStorage = () => globalThis.localStorage }) {
  let applied = 1;
  let requested = 1;
  let pending = null;
  let restored = false;

  function save() {
    try {
      getStorage()?.setItem(PAGE_ZOOM_STORAGE_KEY, String(applied));
    } catch {}
  }

  async function flush() {
    while (applied !== requested) {
      const target = requested;
      try {
        await applyZoom(target);
        applied = target;
        save();
        onChange(Math.round(applied * 100));
      } catch (error) {
        requested = applied;
        onError(error);
      }
    }
  }

  function schedule() {
    if (!pending) {
      pending = Promise.resolve().then(flush).finally(() => { pending = null; });
    }
    return pending;
  }

  function restore() {
    if (restored) return pending || Promise.resolve();
    restored = true;
    try {
      const saved = Number(getStorage()?.getItem(PAGE_ZOOM_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= PAGE_ZOOM_MIN && saved <= PAGE_ZOOM_MAX) {
        requested = Math.round(saved * 10) / 10;
      }
    } catch {}
    return schedule();
  }

  function run(action) {
    if (!["zoomIn", "zoomOut", "zoomReset"].includes(action)) return Promise.resolve();
    restored = true;
    requested = action === "zoomReset" ? 1 : Math.min(PAGE_ZOOM_MAX, Math.max(PAGE_ZOOM_MIN,
      Math.round((requested + (action === "zoomIn" ? 0.1 : -0.1)) * 10) / 10));
    if (requested === applied) save();
    return schedule();
  }

  return { run, restore, get scale() { return applied; } };
}

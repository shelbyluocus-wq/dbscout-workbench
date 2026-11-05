export const PAGE_ZOOM_MIN = 0.5;
export const PAGE_ZOOM_MAX = 2;

export function pageZoomAction(event, platform) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  if (platform === "macos" ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return null;
  if (["+", "="].includes(event.key) || event.code === "NumpadAdd") return "zoomIn";
  if (event.key === "-" || event.code === "NumpadSubtract") return "zoomOut";
  if (!event.shiftKey && (event.key === "0" || event.code === "Numpad0")) return "zoomReset";
  return null;
}

export function createPageZoom({ applyZoom, onChange = () => {}, onError = () => {} }) {
  let applied = 1;
  let requested = 1;
  let pending = null;

  async function flush() {
    while (applied !== requested) {
      const target = requested;
      try {
        await applyZoom(target);
        applied = target;
        onChange(Math.round(applied * 100));
      } catch (error) {
        requested = applied;
        onError(error);
      }
    }
  }

  function run(action) {
    if (!["zoomIn", "zoomOut", "zoomReset"].includes(action)) return Promise.resolve();
    requested = action === "zoomReset" ? 1 : Math.min(PAGE_ZOOM_MAX, Math.max(PAGE_ZOOM_MIN,
      Math.round((requested + (action === "zoomIn" ? 0.1 : -0.1)) * 10) / 10));
    if (!pending) {
      pending = Promise.resolve().then(flush).finally(() => { pending = null; });
    }
    return pending;
  }

  return { run, get scale() { return applied; } };
}

export function createHomepageSelectionDismissal({
  getRoot,
  getProtectedRoots = () => [],
  clearSelection,
  scheduleClear = (callback) => queueMicrotask(callback),
  scheduleGuardReset = (callback) => setTimeout(callback, 0),
} = {}) {
  let suppressNextClick = false;

  function markBoxSelectionComplete() {
    suppressNextClick = true;
    scheduleGuardReset(() => {
      suppressNextClick = false;
    });
  }

  function handleDocumentClick(event) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const target = event?.target;
    const root = getRoot?.();
    if (root?.contains?.(target) && (
      target?.closest?.(".wb-dbhome-object-name") ||
      target?.closest?.(".wb-dbhome-actions")
    )) return;
    if (getProtectedRoots().some((protectedRoot) => protectedRoot?.contains?.(target))) return;
    scheduleClear(() => clearSelection?.());
  }

  return {
    handleDocumentClick,
    markBoxSelectionComplete,
  };
}

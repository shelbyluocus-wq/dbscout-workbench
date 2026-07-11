export function createHomepageSelectionDismissal({
  getRoot,
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
    if (root?.contains?.(target) && target?.closest?.(".wb-dbhome-object-name")) return;
    scheduleClear(() => clearSelection?.());
  }

  return {
    handleDocumentClick,
    markBoxSelectionComplete,
  };
}

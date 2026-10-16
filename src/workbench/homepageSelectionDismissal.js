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
    // The whole row is the selection target (Ctrl/Shift+click anywhere on it),
    // so only clicks outside the rows and the action toolbar dismiss.
    if (root?.contains?.(target) && (
      target?.closest?.(".wb-dbhome-object-row") ||
      target?.closest?.(".wb-dbhome-actions")
    )) return;
    if (target?.closest?.(".wb-activity-more, .wb-activity-more-menu")) return;
    if (getProtectedRoots().some((protectedRoot) => protectedRoot?.contains?.(target))) return;
    // Answering a dialog (such as "Delete 3 tables?" -> Cancel) is not a
    // click elsewhere: the selection it was asked about stays.
    if (target?.closest?.('[aria-modal="true"]')) return;
    scheduleClear(() => clearSelection?.());
  }

  return {
    handleDocumentClick,
    markBoxSelectionComplete,
  };
}

export function createHomepageSelectionDismissal({
  getRoot,
  getProtectedRoots = () => [],
  isEnabled = () => true,
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
    if (!isEnabled()) return;
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
    // Switching tabs (or clicking the active home tab) leaves the selection
    // intact so returning to the homepage resumes right where the user left off.
    if (target?.closest?.(".wb-tab")) return;
    if (getProtectedRoots().some((protectedRoot) => protectedRoot?.contains?.(target))) return;
    // Answering a dialog (such as "Delete 3 tables?" -> Cancel) is not a
    // click elsewhere: the selection it was asked about stays.
    if (target?.closest?.('[aria-modal="true"]')) return;
    scheduleClear(() => {
      if (!isEnabled()) return;
      clearSelection?.();
    });
  }

  return {
    handleDocumentClick,
    markBoxSelectionComplete,
  };
}

// Native-menu ↔ keydown de-duplication gate (macOS).
// A keystroke can, depending on which layer claims it first, reach both the
// in-page keydown handler and a native menu item with the same accelerator.
// `matchesBinding` records the timestamp of every keydown that matched a
// binding; the native menu adapter skips an action whose shortcut was seen
// within MENU_SHORTCUT_DEDUP_MS.
const MENU_SHORTCUT_DEDUP_MS = 300;

const lastKeydownAt = new Map();

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function noteShortcutKeydownMatch(action, at = now()) {
  if (!action) return;
  lastKeydownAt.set(action, at);
}

export function isRecentShortcutKeydown(action, at = now()) {
  const last = lastKeydownAt.get(action);
  return last != null && at - last < MENU_SHORTCUT_DEDUP_MS;
}

// Test-only helper: clears the recorded keydown timestamps.
export function _resetMenuShortcutDedupForTests() {
  lastKeydownAt.clear();
}

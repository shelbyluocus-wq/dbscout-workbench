// Keyboard focus falls back to the document when the focused control is removed.
// Table design replaces the data grid, so Ctrl+D (which previously only listened
// inside the workbench) stops reaching the grid until the user clicks a cell.
export function isStrandedKeyboardFocus(activeElement, root = globalThis.document) {
  if (!activeElement) return true;
  if (activeElement === root) return true;
  if (activeElement === root?.body || activeElement === root?.documentElement) return true;
  return activeElement.isConnected === false;
}

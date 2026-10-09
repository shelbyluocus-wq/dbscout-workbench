/**
 * Table names to open when Enter is pressed on the database home list.
 *
 * Drag-select leaves focus on the list, so Enter already opened every
 * selected table. Ctrl/Shift click focuses the table-name button, which
 * must do the same when that row is part of the selection. A focused row
 * outside the selection still opens only itself.
 *
 * @param {string} focusedName
 * @param {string[]} selectedNames
 * @returns {string[]}
 */
export function homeEnterOpenNames(focusedName = "", selectedNames = []) {
  const selected = [];
  const seen = new Set();
  for (const value of Array.isArray(selectedNames) ? selectedNames : []) {
    const name = String(value ?? "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    selected.push(name);
  }
  const focused = String(focusedName ?? "");
  if (!focused || seen.has(focused)) return selected;
  return [focused];
}

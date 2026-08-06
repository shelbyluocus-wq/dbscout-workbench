/**
 * Resolve the list of table-design targets for a database home tab.
 *
 * The home page supports multi-selection (Ctrl/Cmd toggle, Shift range,
 * Ctrl+A). Opening the table design from the home page should honor that
 * selection: every selected table gets its own design tab. When nothing is
 * selected we fall back to the focused table so a plain click + shortcut
 * still works.
 *
 * @param {Object} home - A home tab object ({ connectionId, database,
 *   selectedTableNames, focusedTableName }).
 * @returns {{ connectionId: string, database: string, tableName: string }[]}
 *   Deduplicated (case-insensitive), selection order preserved.
 */
export function resolveHomeDesignTargets(home = {}) {
  const connectionId = String(home?.connectionId || home?.connection_id || "");
  const database = String(home?.database || "");
  const names = [];
  const seen = new Set();
  const push = (value) => {
    const name = String(value || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  const selected = Array.isArray(home?.selectedTableNames) ? home.selectedTableNames : [];
  selected.forEach(push);
  if (!names.length) push(home?.focusedTableName);
  return names.map((tableName) => ({ connectionId, database, tableName }));
}

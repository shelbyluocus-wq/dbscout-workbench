// Turns table names that appear in comments, cells and relation titles into
// jump targets. A name links only when that table exists in the current
// database; a longer identifier that merely contains the name does not.

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

function tableNameOf(table) {
  return String(table?.table_name || table?.tableName || table?.name || "");
}

function tableCommentOf(table) {
  return String(table?.table_comment || table?.tableComment || table?.comment || "");
}

// `scope` limits the index to one connection and database. Without it, every
// passed table is eligible (used by tests and callers that already filtered).
export function createTableMentionIndex(tables, scope = null) {
  const connectionId = scope ? String(scope.connectionId || "") : null;
  const database = scope ? String(scope.database || "").toLowerCase() : null;
  const byLower = new Map();
  for (const table of tables || []) {
    if (connectionId !== null && String(table?.connectionId || "") !== connectionId) continue;
    if (database !== null && String(table?.database || "").toLowerCase() !== database) continue;
    const name = tableNameOf(table);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (byLower.has(lower)) continue;
    byLower.set(lower, { name, comment: tableCommentOf(table) });
  }
  return byLower;
}

// Null when nothing in the text names a current-database table, so callers
// can keep the plain text path.
export function splitTableMentions(text, index) {
  const value = text == null ? "" : String(text);
  if (!index?.size || !/[A-Za-z_]/.test(value)) return null;
  const parts = [];
  let last = 0;
  let linked = false;
  for (const match of value.matchAll(WORD)) {
    const table = index.get(match[0].toLowerCase());
    if (!table) continue;
    if (match.index > last) parts.push({ text: value.slice(last, match.index) });
    parts.push({ text: match[0], table });
    last = match.index + match[0].length;
    linked = true;
  }
  if (!linked) return null;
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

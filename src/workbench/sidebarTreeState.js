function databaseBranchKey(connectionId, database) {
  return [connectionId, database].map((value) => String(value ?? "")).join("\u001f");
}

function toggleSetValue(values, value) {
  if (values.has(value)) values.delete(value);
  else values.add(value);
}

// Database branches start collapsed. Only the selected database can show its
// tables, and only after the user opens it; the opened branch is forgotten as
// soon as the selection moves to another database (for example through a tab
// switch), so activating a tab never unfolds a table list by itself.
export function createSidebarTreeState() {
  return {
    collapsedConnectionIds: new Set(),
    expandedDatabaseKey: "",
  };
}

export function isConnectionExpanded(state, connectionId, selectedConnectionId) {
  return connectionId === selectedConnectionId && !state.collapsedConnectionIds.has(connectionId);
}

export function isDatabaseExpanded(state, connectionId, database, selectedConnectionId, selectedDatabase) {
  return (
    isConnectionExpanded(state, connectionId, selectedConnectionId) &&
    database === selectedDatabase &&
    state.expandedDatabaseKey === databaseBranchKey(connectionId, database)
  );
}

export function toggleConnectionExpansion(state, connectionId, selectedConnectionId) {
  if (connectionId !== selectedConnectionId) return false;
  toggleSetValue(state.collapsedConnectionIds, connectionId);
  return true;
}

export function toggleDatabaseExpansion(state, connectionId, database, selectedConnectionId, selectedDatabase) {
  if (connectionId !== selectedConnectionId || database !== selectedDatabase) return false;
  const key = databaseBranchKey(connectionId, database);
  state.expandedDatabaseKey = state.expandedDatabaseKey === key ? "" : key;
  return true;
}

export function revealConnection(state, connectionId) {
  state.collapsedConnectionIds.delete(connectionId);
}

// Explicit user requests (clicking a database, focusing table search) open it.
export function revealDatabase(state, connectionId, database) {
  state.expandedDatabaseKey = databaseBranchKey(connectionId, database);
}

// Called whenever the selected source changes: an opened branch survives only
// while its own database stays selected.
export function settleDatabaseExpansion(state, selectedConnectionId, selectedDatabase) {
  if (state.expandedDatabaseKey !== databaseBranchKey(selectedConnectionId, selectedDatabase)) {
    state.expandedDatabaseKey = "";
  }
}

export function collapseAllConnections(state, connectionIds) {
  connectionIds.forEach((id) => state.collapsedConnectionIds.add(id));
}

export function expandAllConnections(state, connectionIds) {
  connectionIds.forEach((id) => state.collapsedConnectionIds.delete(id));
}

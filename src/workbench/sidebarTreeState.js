function databaseBranchKey(connectionId, database) {
  return [connectionId, database].map((value) => String(value ?? "")).join("\u001f");
}

function toggleSetValue(values, value) {
  if (values.has(value)) values.delete(value);
  else values.add(value);
}

export function createSidebarTreeState() {
  return {
    collapsedConnectionIds: new Set(),
    collapsedDatabaseKeys: new Set(),
  };
}

export function isConnectionExpanded(state, connectionId, selectedConnectionId) {
  return connectionId === selectedConnectionId && !state.collapsedConnectionIds.has(connectionId);
}

export function isDatabaseExpanded(state, connectionId, database, selectedConnectionId, selectedDatabase) {
  return (
    isConnectionExpanded(state, connectionId, selectedConnectionId) &&
    database === selectedDatabase &&
    !state.collapsedDatabaseKeys.has(databaseBranchKey(connectionId, database))
  );
}

export function toggleConnectionExpansion(state, connectionId, selectedConnectionId) {
  if (connectionId !== selectedConnectionId) return false;
  toggleSetValue(state.collapsedConnectionIds, connectionId);
  return true;
}

export function toggleDatabaseExpansion(state, connectionId, database, selectedConnectionId, selectedDatabase) {
  if (connectionId !== selectedConnectionId || database !== selectedDatabase) return false;
  toggleSetValue(state.collapsedDatabaseKeys, databaseBranchKey(connectionId, database));
  return true;
}

export function revealConnection(state, connectionId) {
  state.collapsedConnectionIds.delete(connectionId);
}

export function revealDatabase(state, connectionId, database) {
  state.collapsedDatabaseKeys.delete(databaseBranchKey(connectionId, database));
}

export function collapseAllConnections(state, connectionIds) {
  connectionIds.forEach((id) => state.collapsedConnectionIds.add(id));
}

export function expandAllConnections(state, connectionIds) {
  connectionIds.forEach((id) => state.collapsedConnectionIds.delete(id));
}

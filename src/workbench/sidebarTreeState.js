export function databaseBranchKey(connectionId, database) {
  return [connectionId, database].map((value) => String(value ?? "")).join("\u001f");
}

// Database branches start collapsed. Multiple MySQL connections can stay open
// side by side so users can browse and compare servers without losing context,
// while only the active/pending database unfolds its table list.
export function createSidebarTreeState() {
  return {
    collapsedConnectionIds: new Set(),
    expandedConnectionIds: new Set(),
    expandedDatabaseKey: "",
    pendingDatabaseKey: "",
  };
}

export function isConnectionExpanded(state, connectionId, selectedConnectionId) {
  if (!connectionId || state.collapsedConnectionIds.has(connectionId)) return false;
  return connectionId === selectedConnectionId || state.expandedConnectionIds?.has(connectionId) === true;
}

export function areAllConnectionsCollapsed(state, connectionIds, selectedConnectionId) {
  if (!Array.isArray(connectionIds) || connectionIds.length === 0) return false;
  return connectionIds.every((id) => !isConnectionExpanded(state, id, selectedConnectionId));
}

export function isDatabaseExpanded(state, connectionId, database, selectedConnectionId, selectedDatabase) {
  if (!connectionId || !database) return false;
  if (!isConnectionExpanded(state, connectionId, selectedConnectionId)) return false;
  const key = databaseBranchKey(connectionId, database);
  if (state.expandedDatabaseKey !== key) return false;
  return (
    (connectionId === selectedConnectionId && database === selectedDatabase) ||
    state.pendingDatabaseKey === key
  );
}

export function toggleConnectionExpansion(state, connectionId, selectedConnectionId) {
  if (!connectionId) return false;
  if (isConnectionExpanded(state, connectionId, selectedConnectionId)) {
    state.collapsedConnectionIds.add(connectionId);
    state.expandedConnectionIds?.delete(connectionId);
  } else {
    state.collapsedConnectionIds.delete(connectionId);
    state.expandedConnectionIds?.add(connectionId);
  }
  return true;
}

export function toggleDatabaseExpansion(state, connectionId, database, selectedConnectionId, selectedDatabase) {
  if (!connectionId || !database) return false;
  const key = databaseBranchKey(connectionId, database);
  const isSelected = connectionId === selectedConnectionId && database === selectedDatabase;
  const isPendingOpen = state.expandedDatabaseKey === key && state.pendingDatabaseKey === key;
  if (!isSelected && !isPendingOpen) return false;
  if (state.expandedDatabaseKey === key) {
    state.expandedDatabaseKey = "";
    state.pendingDatabaseKey = "";
  } else {
    state.expandedDatabaseKey = key;
    state.pendingDatabaseKey = "";
  }
  return true;
}

export function collapseDatabase(state) {
  state.expandedDatabaseKey = "";
  state.pendingDatabaseKey = "";
}

export function revealConnection(state, connectionId) {
  if (!connectionId) return;
  state.collapsedConnectionIds.delete(connectionId);
  state.expandedConnectionIds?.add(connectionId);
}

export function revealSelectedConnection(state, selectedConnectionId) {
  if (!selectedConnectionId) return;
  state.collapsedConnectionIds.delete(selectedConnectionId);
}

// Explicit user requests (clicking a database, focusing table search) open it.
export function revealDatabase(state, connectionId, database) {
  if (!connectionId || !database) return;
  const key = databaseBranchKey(connectionId, database);
  state.expandedDatabaseKey = key;
  state.pendingDatabaseKey = key;
}

// Called whenever the selected source changes: an opened branch survives while
// its own database is selected or while its cross-server switch is still settling.
export function settleDatabaseExpansion(state, selectedConnectionId, selectedDatabase) {
  if (!selectedDatabase && state.pendingDatabaseKey && state.expandedDatabaseKey === state.pendingDatabaseKey) {
    const [pendingConnId] = state.pendingDatabaseKey.split("\u001f");
    if (!selectedConnectionId || pendingConnId === String(selectedConnectionId)) {
      return;
    }
  }
  const selectedKey = databaseBranchKey(selectedConnectionId, selectedDatabase);
  if (state.expandedDatabaseKey === selectedKey) {
    state.pendingDatabaseKey = "";
    return;
  }
  state.expandedDatabaseKey = "";
  state.pendingDatabaseKey = "";
}

export function collapseAllConnections(state, connectionIds) {
  state.expandedConnectionIds?.clear();
  connectionIds.forEach((id) => state.collapsedConnectionIds.add(id));
}

export function expandAllConnections(state, connectionIds) {
  connectionIds.forEach((id) => {
    state.collapsedConnectionIds.delete(id);
    state.expandedConnectionIds?.add(id);
  });
}

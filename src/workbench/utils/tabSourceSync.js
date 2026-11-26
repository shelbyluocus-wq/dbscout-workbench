/**
 * Keeps the sidebar's selected connection/database in step with the tab the
 * user just activated, in the background.
 *
 * The tab itself already holds its rows, so it is shown first; this only
 * refreshes the sidebar source. Each sync takes a token and stops after any
 * await once a newer activation has started, so a slow earlier switch can
 * never overwrite a later one (rapid Ctrl+Tab across databases).
 */
export function createTabSourceSync({ getSelected, selectConnection, selectDatabase }) {
  let token = 0;

  async function syncToTab(tab) {
    const current = ++token;
    const connectionId = String(tab?.connectionId || "");
    const database = String(tab?.database || "");
    if (!connectionId && !database) return false;
    try {
      const selected = getSelected();
      if (connectionId && connectionId !== String(selected.connectionId || "")) {
        // Pass the tab's database so the connection switch lands on it directly
        // instead of loading the connection's default database first.
        const outcome = await selectConnection(connectionId, { preferredDatabase: database });
        if (current !== token || (outcome && outcome !== "selected")) return false;
      }
      const afterConnection = getSelected();
      if (
        database
        && database !== String(afterConnection.database || "")
        && (!connectionId || connectionId === String(afterConnection.connectionId || ""))
      ) {
        await selectDatabase({ connectionId: connectionId || afterConnection.connectionId, database });
        if (current !== token) return false;
      }
      return true;
    } catch {
      // selectConnection/selectDatabase already report failures in the status bar.
      return false;
    }
  }

  return { syncToTab };
}

import { resolveFieldCommentHeight, resolveGridRowHeight } from "./gridRowHeight.js";
import { normalizeTableFilterMode } from "./tableFilterMode.js";
import { normalizeColumnOrder } from "./columnOrder.js";
import { normalizeRelationFilter, normalizeRelationOrigin } from "./relationFilter.js";

const STORAGE_KEY = "dbscout_workspace";
const SNAPSHOT_VERSION = 4;

function normalizeTabKind(kind) {
  return kind === "design" || kind === "home" || kind === "sql" || kind === "sql-library" ? kind : "data";
}

function normalizeDirection(direction) {
  return direction === "vertical" ? "vertical" : "horizontal";
}

// Relation fields are present only on relation tabs, so ordinary tabs keep
// their exact saved shape. An origin without a valid filter is dropped.
function savedRelation(tab) {
  const relationFilter = normalizeRelationFilter(tab?.relationFilter);
  if (!relationFilter) return {};
  const relationOrigin = normalizeRelationOrigin(tab.relationOrigin);
  return relationOrigin ? { relationFilter, relationOrigin } : { relationFilter };
}

function savedPane(id, pane = {}) {
  return {
    id,
    tabIds: Array.isArray(pane.tabIds) ? pane.tabIds.map((tabId) => String(tabId || "")).filter(Boolean) : [],
    activeTabId: String(pane.activeTabId || ""),
  };
}

function singlePaneForTabs(tabs, activeTabId = "") {
  const tabIds = tabs.map((tab) => tab.id).filter(Boolean);
  const paneActiveTabId = tabIds.includes(activeTabId) ? activeTabId : tabIds[0] || "";
  return {
    panes: {
      "pane-1": { id: "pane-1", tabIds, activeTabId: paneActiveTabId },
    },
    layout: { type: "pane", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  };
}

function firstPaneLayout(panes, tabs, activeTabId = "") {
  const firstPaneId = Object.keys(panes || {})[0];
  if (firstPaneId) return { type: "pane", paneId: firstPaneId };
  return singlePaneForTabs(tabs, activeTabId).layout;
}

function normalizeLayoutNode(node, validPaneIds) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "pane") {
    const paneId = String(node.paneId || "");
    return validPaneIds.has(paneId) ? { type: "pane", paneId } : null;
  }
  if (node.type === "split") {
    const first = normalizeLayoutNode(node.first, validPaneIds);
    const second = normalizeLayoutNode(node.second, validPaneIds);
    if (!first) return second;
    if (!second) return first;
    return {
      type: "split",
      id: String(node.id || "split-1"),
      direction: normalizeDirection(node.direction),
      ratio: clampRatio(node.ratio),
      first,
      second,
    };
  }
  return null;
}

function clampRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(0.82, Math.max(0.18, numeric));
}

function normalizePanes(parsedPanes, tabs, activeTabId = "") {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const panes = {};
  for (const [paneId, pane] of Object.entries(parsedPanes || {})) {
    const id = String(pane?.id || paneId || "");
    if (!id) continue;
    const next = savedPane(id, pane);
    next.tabIds = next.tabIds.filter((tabId) => tabIds.has(tabId));
    if (next.activeTabId && !next.tabIds.includes(next.activeTabId)) {
      next.activeTabId = next.tabIds[0] || "";
    }
    panes[id] = next;
  }
  if (Object.keys(panes).length === 0) return singlePaneForTabs(tabs, activeTabId);
  return { panes };
}

/**
 * Build a lightweight snapshot of workspace state for persistence.
 * Only serializable primitives are stored -- transient data like rows,
 * columns, loading flags, and Sets are excluded.
 */
export function buildWorkspaceSnapshot({
  connectionId = "",
  database = "",
  tabs = [],
  activeTabId = "",
  panes = null,
  layout = null,
  focusedPaneId = "",
}) {
  const savedTabs = tabs.filter((tab) => !tab?.opening).map((tab) => ({
    id: tab.id,
    kind: normalizeTabKind(tab.kind),
    connectionId: tab.connectionId || "",
    database: tab.database || "",
    tableName: tab.tableName || "",
    tableComment: tab.tableComment || "",
    filter: tab.filter || "",
    filterMode: normalizeTableFilterMode(tab.filterMode),
    ...savedRelation(tab),
    sort: tab.sort || null,
    frozenRowStart: Number(tab.frozenRowStart) || 0,
    frozenRowCount: Number(tab.frozenRowCount) || 0,
    frozenColumnCount: Number(tab.frozenColumnCount) || 0,
    columnOrder: normalizeColumnOrder(tab.columnOrder),
    fieldCommentsExpanded: tab.fieldCommentsExpanded !== false,
    rowHeight: resolveGridRowHeight(tab),
    fieldCommentHeight: resolveFieldCommentHeight(tab),
    query: tab.kind === "home" ? String(tab.query || "") : undefined,
    sortMode: tab.kind === "home" ? String(tab.sortMode || "nameAsc") : undefined,
    selectedTableNames: tab.kind === "home" && Array.isArray(tab.selectedTableNames)
      ? [...tab.selectedTableNames]
      : undefined,
    focusedTableName: tab.kind === "home" ? String(tab.focusedTableName || "") : undefined,
    title: tab.kind === "sql" ? String(tab.title || "") : undefined,
    documentId: tab.kind === "sql" ? String(tab.documentId || "") : undefined,
    sql: tab.kind === "sql" ? String(tab.sql || "") : undefined,
    savedSql: tab.kind === "sql" ? String(tab.savedSql || "") : undefined,
    dirty: tab.kind === "sql" ? Boolean(tab.dirty) : undefined,
    filePath: tab.kind === "sql" ? String(tab.filePath || "") : undefined,
    fileName: tab.kind === "sql" ? String(tab.fileName || "") : undefined,
    limit: tab.kind === "sql" ? Number(tab.limit) || 1000 : undefined,
    timeoutSeconds: tab.kind === "sql" ? Number(tab.timeoutSeconds) || 60 : undefined,
    autoCommit: tab.kind === "sql" ? tab.autoCommit !== false : undefined,
    editorRatio: tab.kind === "sql" ? Number(tab.editorRatio) || 0.55 : undefined,
    readOnly: Boolean(tab.readOnly || tab.read_only),
  }));
  const paneState = normalizePanes(panes, savedTabs, activeTabId);
  const savedPanes = paneState.panes;
  const paneIds = new Set(Object.keys(savedPanes));
  const savedLayout = normalizeLayoutNode(layout, paneIds) || firstPaneLayout(savedPanes, savedTabs, activeTabId);
  const savedFocusedPaneId = savedPanes[focusedPaneId] ? focusedPaneId : Object.keys(savedPanes)[0] || "pane-1";
  return {
    version: SNAPSHOT_VERSION,
    connectionId,
    database,
    tabs: savedTabs,
    activeTabId,
    panes: savedPanes,
    layout: savedLayout,
    focusedPaneId: savedFocusedPaneId,
  };
}

/**
 * Save a workspace snapshot to localStorage.
 */
export function saveWorkspaceSnapshot(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage may be unavailable or full -- silently ignore.
  }
}

/**
 * Load a previously saved workspace snapshot from localStorage.
 * Returns null when no valid snapshot exists.
 */
export function loadWorkspaceSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs
          .filter((tab) => tab && typeof tab === "object" && (tab.tableName || tab.kind === "home" || tab.kind === "sql" || tab.kind === "sql-library"))
          .map((tab) => {
            const kind = normalizeTabKind(tab.kind);
            const saved = {
              id: String(tab.id || ""),
              kind,
              connectionId: String(tab.connectionId || ""),
              database: String(tab.database || ""),
              tableName: String(tab.tableName || ""),
              tableComment: String(tab.tableComment || ""),
              filter: String(tab.filter || ""),
              filterMode: normalizeTableFilterMode(tab.filterMode),
              ...savedRelation(tab),
              sort: tab.sort || null,
              frozenRowStart: Number(tab.frozenRowStart) || 0,
              frozenRowCount: Number(tab.frozenRowCount) || 0,
              frozenColumnCount: Number(tab.frozenColumnCount) || 0,
              columnOrder: normalizeColumnOrder(tab.columnOrder),
              fieldCommentsExpanded: tab.fieldCommentsExpanded !== false,
              rowHeight: resolveGridRowHeight(tab),
              fieldCommentHeight: resolveFieldCommentHeight(tab),
              query: String(tab.query || ""),
              sortMode: String(tab.sortMode || "nameAsc"),
              selectedTableNames: Array.isArray(tab.selectedTableNames)
                ? tab.selectedTableNames.map((name) => String(name || "")).filter(Boolean)
                : [],
              focusedTableName: String(tab.focusedTableName || ""),
              readOnly: Boolean(tab.readOnly || tab.read_only),
            };
            if (kind === "sql") Object.assign(saved, {
              title: String(tab.title || ""),
              documentId: String(tab.documentId || ""),
              sql: String(tab.sql || ""),
              savedSql: String(tab.savedSql || ""),
              dirty: Boolean(tab.dirty),
              filePath: String(tab.filePath || ""),
              fileName: String(tab.fileName || ""),
              limit: Number(tab.limit) || 1000,
              timeoutSeconds: Number(tab.timeoutSeconds) || 60,
              autoCommit: tab.autoCommit !== false,
              editorRatio: Number(tab.editorRatio) || 0.55,
            });
            return saved;
          })
      : [];
    const activeTabId = String(parsed.activeTabId || "");
    const supportsPaneLayout = Number(parsed.version) >= 2;
    const paneState = supportsPaneLayout
      ? normalizePanes(parsed.panes, tabs, activeTabId)
      : singlePaneForTabs(tabs, activeTabId);
    const paneIds = new Set(Object.keys(paneState.panes));
    const layout = supportsPaneLayout
      ? normalizeLayoutNode(parsed.layout, paneIds) || firstPaneLayout(paneState.panes, tabs, activeTabId)
      : paneState.layout;
    const focusedPaneId = supportsPaneLayout && paneState.panes?.[parsed.focusedPaneId]
      ? String(parsed.focusedPaneId)
      : (paneState.focusedPaneId || Object.keys(paneState.panes)[0] || "pane-1");
    return {
      version: SNAPSHOT_VERSION,
      connectionId: String(parsed.connectionId || ""),
      database: String(parsed.database || ""),
      tabs,
      activeTabId,
      panes: paneState.panes,
      layout,
      focusedPaneId,
    };
  } catch {
    return null;
  }
}

/**
 * Clear the persisted workspace snapshot.
 */
export function clearWorkspaceSnapshot() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silently ignore.
  }
}

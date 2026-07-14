import { resolveFieldCommentHeight, resolveGridRowHeight } from "./gridRowHeight.js";

const STORAGE_KEY = "dbscout_workspace";
const SNAPSHOT_VERSION = 3;

function normalizeTabKind(kind) {
  return kind === "design" || kind === "home" ? kind : "data";
}

function normalizeDirection(direction) {
  return direction === "vertical" ? "vertical" : "horizontal";
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
    filterMode: tab.filterMode || "fuzzy",
    sort: tab.sort || null,
    frozenRowCount: Number(tab.frozenRowCount) || 0,
    frozenColumnCount: Number(tab.frozenColumnCount) || 0,
    fieldCommentsExpanded: tab.fieldCommentsExpanded !== false,
    rowHeight: resolveGridRowHeight(tab),
    fieldCommentHeight: resolveFieldCommentHeight(tab),
    query: tab.kind === "home" ? String(tab.query || "") : undefined,
    sortMode: tab.kind === "home" ? String(tab.sortMode || "nameAsc") : undefined,
    selectedTableNames: tab.kind === "home" && Array.isArray(tab.selectedTableNames)
      ? [...tab.selectedTableNames]
      : undefined,
    focusedTableName: tab.kind === "home" ? String(tab.focusedTableName || "") : undefined,
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
          .filter((tab) => tab && typeof tab === "object" && (tab.tableName || tab.kind === "home"))
          .map((tab) => ({
            id: String(tab.id || ""),
            kind: normalizeTabKind(tab.kind),
            connectionId: String(tab.connectionId || ""),
            database: String(tab.database || ""),
            tableName: String(tab.tableName || ""),
            tableComment: String(tab.tableComment || ""),
            filter: String(tab.filter || ""),
            filterMode: String(tab.filterMode || "fuzzy"),
            sort: tab.sort || null,
            frozenRowCount: Number(tab.frozenRowCount) || 0,
            frozenColumnCount: Number(tab.frozenColumnCount) || 0,
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
          }))
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

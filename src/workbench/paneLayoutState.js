const MIN_SPLIT_RATIO = 0.18;
const MAX_SPLIT_RATIO = 0.82;

function nextId(prefix, sequence) {
  return `${prefix}-${sequence}`;
}

function normalizeDirection(direction) {
  return direction === "down" || direction === "vertical" ? "vertical" : "horizontal";
}

function placementFor(direction) {
  return direction === "down" || direction === "vertical"
    ? { splitDirection: "vertical", newPaneSide: "second" }
    : { splitDirection: "horizontal", newPaneSide: "second" };
}

function clampRatio(ratio) {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, numeric));
}

export function createPaneRecord(id, values = {}) {
  return {
    id,
    tabIds: Array.isArray(values.tabIds) ? [...values.tabIds] : [],
    activeTabId: String(values.activeTabId || ""),
  };
}

export function createPaneLayoutState() {
  const pane = createPaneRecord("pane-1");
  return {
    panes: { [pane.id]: pane },
    layout: { type: "pane", paneId: pane.id },
    focusedPaneId: pane.id,
    nextPaneSeq: 2,
    nextSplitSeq: 1,
  };
}

export function listPaneIds(node) {
  if (!node) return [];
  if (node.type === "pane") return [node.paneId].filter(Boolean);
  if (node.type === "split") return [...listPaneIds(node.first), ...listPaneIds(node.second)];
  return [];
}

function findPaneNodeRef(container, paneId) {
  if (!container?.node) return null;
  const node = container.node;
  if (node.type === "pane") return node.paneId === paneId ? container : null;
  if (node.type !== "split") return null;
  return (
    findPaneNodeRef({ node: node.first, parent: node, key: "first" }, paneId) ||
    findPaneNodeRef({ node: node.second, parent: node, key: "second" }, paneId)
  );
}

export function splitPaneInLayout(state, paneId, direction = "right") {
  if (!state?.layout || !state?.panes?.[paneId]) return null;
  const target = findPaneNodeRef({ node: state.layout, parent: null, key: "layout" }, paneId);
  if (!target) return null;
  const pane = createPaneRecord(nextId("pane", state.nextPaneSeq++));
  const splitId = nextId("split", state.nextSplitSeq++);
  const { splitDirection, newPaneSide } = placementFor(direction);
  const existingNode = target.node;
  const newPaneNode = { type: "pane", paneId: pane.id };
  const splitNode = {
    type: "split",
    id: splitId,
    direction: splitDirection,
    ratio: 0.5,
    first: newPaneSide === "first" ? newPaneNode : existingNode,
    second: newPaneSide === "second" ? newPaneNode : existingNode,
  };
  if (target.parent) target.parent[target.key] = splitNode;
  else state.layout = splitNode;
  state.panes[pane.id] = pane;
  state.focusedPaneId = pane.id;
  return pane;
}

function findPaneWithParent(node, paneId, parent = null, key = "") {
  if (!node) return null;
  if (node.type === "pane") return node.paneId === paneId ? { node, parent, key } : null;
  if (node.type !== "split") return null;
  return findPaneWithParent(node.first, paneId, node, "first") || findPaneWithParent(node.second, paneId, node, "second");
}

function firstPaneId(node) {
  return listPaneIds(node)[0] || "";
}

function nodeContainsPane(node, paneId) {
  if (!node || !paneId) return false;
  if (node.type === "pane") return node.paneId === paneId;
  if (node.type !== "split") return false;
  return nodeContainsPane(node.first, paneId) || nodeContainsPane(node.second, paneId);
}

function firstRemainingPaneId(state, excluding = new Set()) {
  return listPaneIds(state?.layout)
    .find((paneId) => state.panes?.[paneId] && !excluding.has(paneId)) || "";
}

export function closePaneInLayout(state, paneId) {
  if (!state?.layout || !state?.panes?.[paneId]) return null;
  const allPanes = listPaneIds(state.layout);
  if (allPanes.length <= 1) return null;
  const match = findPaneWithParent(state.layout, paneId);
  if (!match?.parent) return null;
  const siblingKey = match.key === "first" ? "second" : "first";
  const sibling = match.parent[siblingKey];
  const targetPaneId = firstPaneId(sibling);
  const parentInfo = findSplitParent(state.layout, match.parent.id);
  if (parentInfo) {
    parentInfo.parent[parentInfo.key] = sibling;
  } else {
    state.layout = sibling;
  }
  if (targetPaneId && targetPaneId !== paneId) {
    const closedTabs = state.panes[paneId].tabIds || [];
    const targetPane = state.panes[targetPaneId];
    if (targetPane) {
      targetPane.tabIds = [...targetPane.tabIds, ...closedTabs.filter((tabId) => !targetPane.tabIds.includes(tabId))];
      if (!targetPane.activeTabId && targetPane.tabIds.length) targetPane.activeTabId = targetPane.tabIds.at(-1);
    }
  }
  delete state.panes[paneId];
  state.focusedPaneId = state.panes[state.focusedPaneId] ? state.focusedPaneId : targetPaneId;
  return { closedPaneId: paneId, targetPaneId };
}

export function pruneEmptyPanesInLayout(state) {
  if (!state?.layout || !state?.panes) return { closedPaneIds: [] };
  const paneIds = listPaneIds(state.layout).filter((paneId) => state.panes[paneId]);
  if (paneIds.length <= 1) {
    const onlyPaneId = paneIds[0] || Object.keys(state.panes)[0] || "pane-1";
    if (state.panes[onlyPaneId]) {
      state.layout = { type: "pane", paneId: onlyPaneId };
      state.focusedPaneId = onlyPaneId;
      if (Object.prototype.hasOwnProperty.call(state, "activeTabId")) {
        state.activeTabId = state.panes[onlyPaneId]?.activeTabId || "";
      }
    }
    return { closedPaneIds: [] };
  }

  const panesWithTabs = paneIds.filter((paneId) => (state.panes[paneId]?.tabIds || []).length > 0);
  const keepPaneId = panesWithTabs[0] || paneIds[0];
  const closedPaneIds = [];

  for (const paneId of paneIds) {
    if (paneId === keepPaneId) continue;
    const pane = state.panes[paneId];
    if (!pane || (pane.tabIds || []).length > 0) continue;
    const result = closePaneInLayout(state, paneId);
    if (result?.closedPaneId) closedPaneIds.push(result.closedPaneId);
  }

  if (!nodeContainsPane(state.layout, state.focusedPaneId)) {
    state.focusedPaneId = firstRemainingPaneId(state) || keepPaneId;
  }
  const focusedPane = state.panes[state.focusedPaneId];
  if (focusedPane) {
    focusedPane.activeTabId = focusedPane.activeTabId && focusedPane.tabIds.includes(focusedPane.activeTabId)
      ? focusedPane.activeTabId
      : focusedPane.tabIds[0] || "";
    if (Object.prototype.hasOwnProperty.call(state, "activeTabId")) {
      state.activeTabId = focusedPane.activeTabId || "";
    }
  }
  return { closedPaneIds };
}

function findSplitParent(node, splitId, parent = null, key = "") {
  if (!node) return null;
  if (node.type === "split" && node.id === splitId) return parent ? { node, parent, key } : null;
  if (node.type !== "split") return null;
  return findSplitParent(node.first, splitId, node, "first") || findSplitParent(node.second, splitId, node, "second");
}

export function resizeSplitInLayout(node, splitId, ratio) {
  if (!node) return false;
  if (node.type === "split" && node.id === splitId) {
    node.ratio = clampRatio(ratio);
    return true;
  }
  if (node.type !== "split") return false;
  return resizeSplitInLayout(node.first, splitId, ratio) || resizeSplitInLayout(node.second, splitId, ratio);
}

export function normalizePaneLayoutState(value) {
  const fallback = createPaneLayoutState();
  if (!value || typeof value !== "object") return fallback;
  const panes = {};
  for (const [paneId, pane] of Object.entries(value.panes || {})) {
    if (!paneId) continue;
    panes[paneId] = createPaneRecord(paneId, pane);
  }
  if (Object.keys(panes).length === 0) return fallback;
  const paneIds = new Set(Object.keys(panes));
  const layout = normalizeLayoutNode(value.layout, paneIds) || { type: "pane", paneId: Object.keys(panes)[0] };
  const visiblePaneIds = new Set(listPaneIds(layout));
  for (const paneId of Object.keys(panes)) {
    if (!visiblePaneIds.has(paneId)) delete panes[paneId];
  }
  const focusedPaneId = panes[value.focusedPaneId] ? value.focusedPaneId : listPaneIds(layout)[0];
  return {
    panes,
    layout,
    focusedPaneId,
    nextPaneSeq: Math.max(coerceSeq(value.nextPaneSeq, "pane", Object.keys(panes)), Object.keys(panes).length + 1),
    nextSplitSeq: coerceSeq(value.nextSplitSeq, "split", collectSplitIds(layout)),
  };
}

function normalizeLayoutNode(node, paneIds) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "pane") {
    const paneId = String(node.paneId || "");
    return paneIds.has(paneId) ? { type: "pane", paneId } : null;
  }
  if (node.type === "split") {
    const first = normalizeLayoutNode(node.first, paneIds);
    const second = normalizeLayoutNode(node.second, paneIds);
    if (!first) return second;
    if (!second) return first;
    return {
      type: "split",
      id: String(node.id || "split-1"),
      direction: normalizeDirection(node.direction),
      ratio: clampRatio(node.ratio ?? 0.5),
      first,
      second,
    };
  }
  return null;
}

function collectSplitIds(node, ids = []) {
  if (node?.type === "split") {
    ids.push(node.id);
    collectSplitIds(node.first, ids);
    collectSplitIds(node.second, ids);
  }
  return ids;
}

function coerceSeq(value, prefix, ids) {
  const numeric = Math.floor(Number(value));
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const maxId = ids.reduce((max, id) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(id || ""));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return maxId + 1;
}

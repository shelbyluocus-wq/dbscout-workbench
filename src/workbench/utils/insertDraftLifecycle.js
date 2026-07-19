export const INSERT_DRAFT_CLOSE_DECISION = Object.freeze({
  SAVE: "save",
  DISCARD: "discard",
  CANCEL: "cancel",
});

export function insertDraftRows(tab) {
  return Array.isArray(tab?.insertDrafts) ? tab.insertDrafts : [];
}

export function tabsWithInsertDrafts(tabs) {
  const seen = new Set();
  return (Array.isArray(tabs) ? tabs : []).filter((tab) => {
    if (!tab?.id || seen.has(tab.id) || insertDraftRows(tab).length === 0) return false;
    seen.add(tab.id);
    return true;
  });
}

function isClosableTab(tab) {
  return Boolean(tab?.id) && String(tab.kind || "data") !== "home";
}

export function closableTabsInPane(tabs, paneTabIds) {
  const byId = new Map((Array.isArray(tabs) ? tabs : []).map((tab) => [tab?.id, tab]));
  return (Array.isArray(paneTabIds) ? paneTabIds : [])
    .map((tabId) => byId.get(tabId))
    .filter(isClosableTab);
}

export function closableRelativeTabsInPane(tabs, paneTabIds, contextTabId, direction = "right") {
  const ids = Array.isArray(paneTabIds) ? paneTabIds : [];
  const contextIndex = ids.indexOf(contextTabId);
  if (contextIndex < 0) return [];
  const candidateIds = direction === "left"
    ? ids.slice(0, contextIndex)
    : ids.slice(contextIndex + 1);
  return closableTabsInPane(tabs, candidateIds);
}

export function discardInsertDrafts(tab) {
  insertDraftRows(tab).splice(0);
  return true;
}

export async function guardInsertDraftTabs(
  tabs,
  {
    decide,
    saveDrafts,
    discardDrafts = discardInsertDrafts,
    isDraftSaving = () => false,
  } = {},
) {
  const dirtyTabs = tabsWithInsertDrafts(tabs);
  if (dirtyTabs.length === 0) return { proceed: true, decision: null, dirtyTabs: [] };
  const rowCount = dirtyTabs.reduce((total, tab) => total + insertDraftRows(tab).length, 0);
  const decision = await decide?.({ tabs: dirtyTabs, rowCount });
  if (decision === INSERT_DRAFT_CLOSE_DECISION.DISCARD) {
    for (const tab of dirtyTabs) {
      const savingRow = insertDraftRows(tab).find((row) => isDraftSaving(tab, row?.id));
      if (savingRow) {
        return {
          proceed: false,
          decision,
          dirtyTabs,
          blockedTab: tab,
          blockedRowId: savingRow.id,
        };
      }
    }
    dirtyTabs.forEach((tab) => discardDrafts(tab));
    return { proceed: true, decision, dirtyTabs };
  }
  if (decision !== INSERT_DRAFT_CLOSE_DECISION.SAVE) {
    return { proceed: false, decision: INSERT_DRAFT_CLOSE_DECISION.CANCEL, dirtyTabs };
  }

  for (const tab of dirtyTabs) {
    const rowIds = insertDraftRows(tab).map((row) => row?.id).filter(Boolean);
    const result = await saveDrafts?.(tab, rowIds);
    if (result?.failedRowId || Number(result?.insertedRows || 0) !== rowIds.length) {
      return { proceed: false, decision, dirtyTabs, failedTab: tab, result };
    }
  }
  return { proceed: true, decision, dirtyTabs };
}

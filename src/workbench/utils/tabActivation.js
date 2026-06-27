export function shouldResetGridForTabActivation(currentTabId, nextTabId) {
  return Boolean(nextTabId) && String(currentTabId || "") !== String(nextTabId || "");
}


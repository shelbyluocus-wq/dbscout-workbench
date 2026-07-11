export function isPublishedTab(tab) {
  return Boolean(tab) && tab.opening !== true;
}

export function publishedTabsForPane(tabs = [], pane = null) {
  const ids = new Set(pane?.tabIds || []);
  return tabs.filter((tab) => ids.has(tab?.id) && isPublishedTab(tab));
}

export function publishedActiveTabForPane(tabs = [], pane = null) {
  if (!pane?.activeTabId) return null;
  return publishedTabsForPane(tabs, pane).find((tab) => tab.id === pane.activeTabId) || null;
}

export function adjacentPublishedTabId(tabs = [], pane = null, direction = "next") {
  const published = publishedTabsForPane(tabs, pane);
  if (published.length < 2) return "";
  const activeIndex = published.findIndex((tab) => tab.id === pane?.activeTabId);
  if (direction === "previous") {
    return published[activeIndex <= 0 ? published.length - 1 : activeIndex - 1]?.id || "";
  }
  return published[activeIndex < 0 ? 0 : (activeIndex + 1) % published.length]?.id || "";
}

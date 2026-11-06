export function partitionTabs(tabs, activeTabId, availableWidth) {
  const widthOf = (tab) => tab.kind === "home" ? 64 : 112;
  const requiredWidth = tabs.reduce((width, tab) => width + widthOf(tab) + 2, 0);
  if (requiredWidth <= availableWidth) return { visible: tabs, overflow: [] };
  let remaining = Math.max(0, availableWidth - 48);
  const visibleIds = new Set();
  for (const tab of tabs) {
    if (remaining < widthOf(tab) + 2) break;
    visibleIds.add(tab.id);
    remaining -= widthOf(tab) + 2;
  }
  const active = tabs.find((tab) => tab.id === activeTabId);
  const home = tabs.find((tab) => tab.kind === "home");
  for (const required of [home, active].filter(Boolean)) {
    if (visibleIds.has(required.id)) continue;
    for (const tab of [...tabs].reverse()) {
      if (remaining >= widthOf(required) + 2) break;
      if (!visibleIds.has(tab.id) || tab === home || tab === active) continue;
      visibleIds.delete(tab.id);
      remaining += widthOf(tab) + 2;
    }
    visibleIds.add(required.id);
    remaining -= widthOf(required) + 2;
  }
  return {
    visible: tabs.filter((tab) => visibleIds.has(tab.id)),
    overflow: tabs.filter((tab) => !visibleIds.has(tab.id)),
  };
}

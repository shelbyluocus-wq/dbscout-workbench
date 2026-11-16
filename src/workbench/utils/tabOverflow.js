export function partitionTabs(tabs, activeTabId, availableWidth) {
  // Every pill, home included, shares one width and shrinks to 100px with a
  // 4px gap; a strip shows only as many pills as fit at that size.
  const widthOf = () => 100;
  const requiredWidth = tabs.reduce((width, tab) => width + widthOf(tab) + 4, 0);
  if (requiredWidth <= availableWidth) return { visible: tabs, overflow: [] };
  let remaining = Math.max(0, availableWidth - 48);
  const visibleIds = new Set();
  for (const tab of tabs) {
    if (remaining < widthOf(tab) + 4) break;
    visibleIds.add(tab.id);
    remaining -= widthOf(tab) + 4;
  }
  const active = tabs.find((tab) => tab.id === activeTabId);
  const home = tabs.find((tab) => tab.kind === "home");
  for (const required of [home, active].filter(Boolean)) {
    if (visibleIds.has(required.id)) continue;
    for (const tab of [...tabs].reverse()) {
      if (remaining >= widthOf(required) + 4) break;
      if (!visibleIds.has(tab.id) || tab === home || tab === active) continue;
      visibleIds.delete(tab.id);
      remaining += widthOf(tab) + 4;
    }
    visibleIds.add(required.id);
    remaining -= widthOf(required) + 4;
  }
  return {
    visible: tabs.filter((tab) => visibleIds.has(tab.id)),
    overflow: tabs.filter((tab) => !visibleIds.has(tab.id)),
  };
}

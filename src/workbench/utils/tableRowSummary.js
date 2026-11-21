import { tabRowCount } from "../rowStore.js";
import { tableWindowOffset } from "./tableScrollWindow.js";

function formatNumber(value) {
  const num = Math.max(0, Math.floor(Number(value) || 0));
  return num.toLocaleString("en-US");
}

/**
 * Formats a concise, user-facing row count summary for the table toolbar and
 * bottom status bar (e.g. "共 54 行", "已加载 200 / 1,240 行", "已加载 200+ 行").
 */
export function formatTableRowSummary(tab, translate) {
  if (!tab || tab.loading || tab.loadError) return "";
  const loaded = Math.max(0, Math.floor(Number(tabRowCount(tab)) || 0));
  const total = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
  const exact = tab.totalRowsExact !== false;
  const hasMore = tab.hasMore === true;
  const windowOffset = tableWindowOffset(tab);

  if (windowOffset > 0 && loaded > 0) {
    const start = formatNumber(windowOffset + 1);
    const end = formatNumber(windowOffset + loaded);
    if (exact && total > 0) {
      return translate("tableSummary.windowRange", { start, end, total: formatNumber(total) });
    }
    return translate("tableSummary.windowRangeOpen", { start, end });
  }

  if (exact && total > 0) {
    if (loaded > 0 && loaded < total && hasMore) {
      return translate("tableSummary.loadedOfTotal", {
        loaded: formatNumber(loaded),
        total: formatNumber(total),
      });
    }
    return translate("tableSummary.exactRows", { count: formatNumber(Math.max(total, loaded)) });
  }

  if (hasMore) {
    return translate("tableSummary.loadedMore", { loaded: formatNumber(loaded) });
  }
  return translate("tableSummary.exactRows", { count: formatNumber(loaded) });
}

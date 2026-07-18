import { findRowByKey } from "./rowIdentity.js";
import { gridSelectionCount } from "./gridCellSelection.js";

function formatPrimaryKeyValue(value) {
  if (value == null) return "NULL";
  if (value === "") return '""';
  return String(value);
}

function selectedCellCount(tab, selectedRange) {
  if (!selectedRange || selectedRange.tabId !== tab.id) return 0;
  const count = gridSelectionCount(selectedRange);
  return count > 1 ? count : 0;
}

export function buildSelectedCellIdentity(tab, selectedCell, selectedRange) {
  if (!tab || !selectedCell || selectedCell.tabId !== tab.id) return null;
  const row = findRowByKey(tab, selectedCell.rowKey);
  if (!row) return null;

  const primaryKeys = Array.isArray(tab.primaryKeys) ? tab.primaryKeys.filter(Boolean) : [];
  const keyLabel = primaryKeys.length === 0 ? "无主键" : primaryKeys.length === 1 ? "主键" : "多主键";
  const primaryKeyText = primaryKeys
    .map((key) => `${key}=${formatPrimaryKeyValue(row[key])}`)
    .join(" + ");
  const selectedCount = selectedCellCount(tab, selectedRange);
  const title = [
    `当前字段 ${selectedCell.column}`,
    primaryKeyText ? `${keyLabel} ${primaryKeyText}` : keyLabel,
    selectedCount ? `已选 ${selectedCount} 个单元格` : "",
  ].filter(Boolean).join(" | ");

  return {
    column: String(selectedCell.column || ""),
    keyLabel,
    primaryKeyText,
    selectedCount,
    title,
  };
}

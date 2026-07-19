import { ensureTabRowStore, mutateTabRow } from "../rowStore.js";
import { buildRowKey } from "./rowIdentity.js";
import { createRowIndex } from "./rowIndex.js";

function comparableCellValue(value) {
  return value == null ? null : String(value);
}

export function applyCommittedCellToTab(tab, { rowKey, column, oldValue, newValue } = {}) {
  if (!tab || !rowKey || !column) return false;
  let rowIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(rowKey);
  if (rowIndex < 0) {
    const store = ensureTabRowStore(tab);
    for (const loaded of store?.iterateLoadedRange?.() || []) {
      const keyBeforeChange = buildRowKey(tab, { ...loaded.row, [column]: oldValue });
      if (keyBeforeChange !== rowKey) continue;
      rowIndex = loaded.absoluteIndex;
      break;
    }
  }
  if (rowIndex < 0) return false;

  let applied = false;
  mutateTabRow(tab, rowIndex, (row) => {
    if (comparableCellValue(row?.[column]) !== comparableCellValue(oldValue)) return row;
    row[column] = newValue;
    applied = true;
    return row;
  });
  return applied;
}

/**
 * Excel (xlsx) hard limit on the number of characters a single cell can hold.
 * SheetJS does not auto-truncate; `XLSX.write` throws
 * "Text length must not exceed 32767 characters" when a string cell exceeds
 * this. We clamp every exported cell value to this length before building the
 * worksheet so batch export of wide/long-text tables doesn't fail (#1).
 */
export const EXCEL_CELL_TEXT_LIMIT = 32767;

/**
 * Clamp a value for XLSX export. Non-strings (numbers, booleans, null) are
 * returned untouched — only string cells can exceed Excel's limit. Strings
 * longer than the limit are truncated to it.
 *
 * @param {*} value - The raw cell value about to be written to a worksheet.
 * @returns {*} The value, with over-long strings truncated to 32767 chars.
 */
export function clampCellValue(value) {
  if (typeof value !== "string") return value;
  if (value.length <= EXCEL_CELL_TEXT_LIMIT) return value;
  return value.slice(0, EXCEL_CELL_TEXT_LIMIT);
}

/**
 * Map a row into an array of clamped cell values, aligned to `header`.
 * Mirrors the `header.map(col => row[col] ?? "")` pattern used by the export
 * paths but applies `clampCellValue` to every cell.
 *
 * @param {object} row - Source row object.
 * @param {string[]} header - Column names (already normalized).
 * @returns {Array} Cell values safe for `aoa_to_sheet`.
 */
export function rowToClampedCells(row, header) {
  return header.map((col) => clampCellValue(row?.[col] ?? ""));
}

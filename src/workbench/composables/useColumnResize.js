import { reactive } from "vue";

import { MIN_COL_WIDTH, MAX_COL_WIDTH, ROW_INDEX_WIDTH, COL_PADDING, AUTOFIT_DEBOUNCE_MS } from "../constants.js";

const AUTOFIT_SAMPLE_ROW_LIMIT = 1000;
const LONG_VALUE_CHAR_LIMIT = 36;
const ASCII_CHAR_WIDTH = 7.2;
const WIDE_CHAR_WIDTH = 12;
const VALUE_CHROME_WIDTH = COL_PADDING + 16;

/**
 * Manages column widths for the data grid, including manual drag-resize
 * and adaptive auto-fit based on the available viewport width.
 *
 * Widths are stored in a plain object keyed by `tabId:colName`.
 * A separate Set tracks which keys were set by the user via drag,
 * so that auto-fit can preserve manual overrides.
 */
export function useColumnResize() {
  const widths = reactive({});
  const manuallySet = new Set();
  let dragJustEndedAt = 0;
  let debounceTimer = null;

  function getColumnWidth(tabId, colName) {
    return widths[`${tabId}:${colName}`];
  }

  function setColumnWidth(tabId, colName, px) {
    widths[`${tabId}:${colName}`] = px;
  }

  function isManuallySet(tabId, colName) {
    return manuallySet.has(`${tabId}:${colName}`);
  }

  function markManual(tabId, colName) {
    manuallySet.add(`${tabId}:${colName}`);
  }

  function wasDragJustEnded() {
    return Date.now() - dragJustEndedAt < 200;
  }

  function onHandleMouseDown(e, tabId, colName) {
    const th = e.target.closest("th");
    if (!th) return;
    const currentWidth = Math.round(th.getBoundingClientRect().width);
    e.preventDefault();
    e.stopPropagation();

    const table = th.closest("table");
    const colIndex = Array.from(th.parentNode.children).indexOf(th);
    const key = `${tabId}:${colName}`;

    applyColumnWidth(table, colIndex, currentWidth);

    const startX = e.clientX;
    const startWidth = currentWidth;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev) {
      const delta = ev.clientX - startX;
      const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startWidth + delta));
      applyColumnWidth(table, colIndex, next);
    }

    function onUp() {
      dragJustEndedAt = Date.now();
      const finalWidth = parseInt(th.style.width) || startWidth;
      widths[key] = finalWidth;
      manuallySet.add(key);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function applyColumnWidth(table, colIndex, px) {
    for (const row of table.querySelectorAll("tr")) {
      const cell = row.children[colIndex];
      if (cell) {
        cell.style.width = px + "px";
        cell.style.minWidth = px + "px";
        cell.style.maxWidth = px + "px";
      }
    }
  }

  // ── Adaptive auto-fit ─────────────────────────────────────────────────

  /**
   * Compute the minimum readable width for a column based on its header text.
   * Uses character count * approximate char width + padding.
   */
  function headerMinWidth(headerText) {
    // Rough heuristic: 7.5px per character at 12px font (monospace-ish average),
    // plus fixed padding for sort indicator and resize handle.
    const textWidth = Math.ceil(String(headerText || "").length * 7.5);
    return Math.max(MIN_COL_WIDTH, textWidth + COL_PADDING + 24);
  }

  function displaySampleValue(value) {
    if (value == null) return "NULL";
    return String(value);
  }

  function exceedsWeightedCharLimit(text, limit) {
    let total = 0;
    for (const char of String(text || "")) {
      total += char.charCodeAt(0) > 255 ? 2 : 1;
      if (total > limit) return true;
    }
    return false;
  }

  function estimateTextWidth(text) {
    return Array.from(String(text || "")).reduce((total, char) => {
      return total + (char.charCodeAt(0) > 255 ? WIDE_CHAR_WIDTH : ASCII_CHAR_WIDTH);
    }, 0);
  }

  function sampledContentWidth(columnName, rows, headerWidth) {
    const samples = Array.isArray(rows) ? rows.slice(0, AUTOFIT_SAMPLE_ROW_LIMIT) : [];
    if (samples.length === 0) return { width: headerWidth, canGrow: false };

    let maxValueWidth = 0;
    let hasValue = false;
    for (const row of samples) {
      if (!row || !Object.prototype.hasOwnProperty.call(row, columnName)) continue;
      const text = displaySampleValue(row[columnName]);
      hasValue = true;
      if (exceedsWeightedCharLimit(text, LONG_VALUE_CHAR_LIMIT)) {
        return { width: headerWidth, canGrow: false };
      }
      maxValueWidth = Math.max(maxValueWidth, Math.ceil(estimateTextWidth(text)) + VALUE_CHROME_WIDTH);
    }

    if (!hasValue) return { width: headerWidth, canGrow: false };
    const width = Math.max(headerWidth, Math.min(MAX_COL_WIDTH, maxValueWidth));
    return { width, canGrow: width > headerWidth };
  }

  function distributeExtraWidth(specs, extraWidth) {
    let remaining = Math.max(0, extraWidth);
    let growable = specs.filter((spec) => spec.canGrow && spec.width < MAX_COL_WIDTH);
    while (remaining > 0.5 && growable.length > 0) {
      const share = remaining / growable.length;
      let distributed = 0;
      for (const spec of growable) {
        const room = MAX_COL_WIDTH - spec.width;
        const add = Math.min(room, share);
        spec.width += add;
        distributed += add;
      }
      if (distributed <= 0) break;
      remaining -= distributed;
      growable = growable.filter((spec) => spec.width < MAX_COL_WIDTH);
    }
  }

  function autoFitColumnsFromSample(availableWidth, existingTotal, unsetColNames, rows) {
    const specs = unsetColNames.map((name) => {
      const headerWidth = headerMinWidth(name);
      const content = sampledContentWidth(name, rows, headerWidth);
      return { name, width: content.width, canGrow: content.canGrow };
    });
    const baseTotal = specs.reduce((total, spec) => total + spec.width, 0);
    distributeExtraWidth(specs, availableWidth - existingTotal - baseTotal);
    return specs;
  }

  /**
   * Calculate initial adaptive column widths to fill the available grid viewport.
   * Existing widths stay fixed so a manual resize does not redistribute siblings.
   *
   * @param {HTMLElement} gridWrapEl - The scrollable grid container element
   * @param {string} tabId - Current tab ID
   * @param {Array<{column_name?: string, columnName?: string}>} columns - Column metadata
   * @param {Array<Record<string, unknown>>} rows - Loaded table rows used as an auto-fit sample
   * @returns {void} Updates internal widths map
   */
  function autoFitColumns(gridWrapEl, tabId, columns, rows = []) {
    if (!gridWrapEl || !tabId || !columns?.length) return;

    const availableWidth = gridWrapEl.clientWidth - ROW_INDEX_WIDTH;
    if (availableWidth <= 0) return;

    const colNames = columns.map((c) => c?.column_name || c?.columnName || "");
    const unsetColNames = colNames.filter((name) => widths[`${tabId}:${name}`] == null);
    if (unsetColNames.length === 0) return;

    const existingTotal = colNames.reduce((total, name) => total + (widths[`${tabId}:${name}`] || 0), 0);
    const remainingForUnset = Math.max(0, availableWidth - existingTotal);
    const sampledRows = Array.isArray(rows) ? rows.slice(0, AUTOFIT_SAMPLE_ROW_LIMIT) : [];

    if (sampledRows.length > 0) {
      for (const spec of autoFitColumnsFromSample(availableWidth, existingTotal, unsetColNames, sampledRows)) {
        widths[`${tabId}:${spec.name}`] = Math.round(spec.width);
      }
      return;
    }

    const targetAutoWidth = remainingForUnset / unsetColNames.length;
    for (const name of unsetColNames) {
      widths[`${tabId}:${name}`] = Math.round(Math.max(headerMinWidth(name), Math.min(MAX_COL_WIDTH, targetAutoWidth)));
    }
  }

  /**
   * Debounced version of autoFitColumns for resize events.
   */
  function autoFitDebounced(gridWrapEl, tabId, columns, rows = []) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      autoFitColumns(gridWrapEl, tabId, columns, rows);
    }, AUTOFIT_DEBOUNCE_MS);
  }

  /**
   * Clear auto-fit widths for a tab, preserving manually-set widths.
   * Called when switching away from a tab so that returning to it re-fits.
   */
  function clearAutoWidths(tabId, columns) {
    if (!tabId || !columns?.length) return;
    for (const col of columns) {
      const name = col?.column_name || col?.columnName || "";
      const key = `${tabId}:${name}`;
      if (!manuallySet.has(key)) {
        delete widths[key];
      }
    }
  }

  return {
    getColumnWidth,
    setColumnWidth,
    isManuallySet,
    markManual,
    onHandleMouseDown,
    wasDragJustEnded,
    autoFitColumns,
    autoFitDebounced,
    clearAutoWidths,
    MIN_COL_WIDTH,
    MAX_COL_WIDTH,
  };
}

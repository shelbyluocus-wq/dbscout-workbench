import { MIN_COL_WIDTH, MAX_COL_WIDTH, ROW_INDEX_WIDTH, COL_PADDING, AUTOFIT_DEBOUNCE_MS } from "../constants.js";

/**
 * Manages column widths for the data grid, including manual drag-resize
 * and adaptive auto-fit based on the available viewport width.
 *
 * Widths are stored in a plain object keyed by `tabId:colName`.
 * A separate Set tracks which keys were set by the user via drag,
 * so that auto-fit can preserve manual overrides.
 */
export function useColumnResize() {
  const widths = {};
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

  /**
   * Calculate adaptive column widths to fill the available grid viewport.
   * Columns that were manually resized by the user keep their widths.
   * The remaining space is distributed among auto-fitted columns.
   *
   * @param {HTMLElement} gridWrapEl - The scrollable grid container element
   * @param {string} tabId - Current tab ID
   * @param {Array<{column_name?: string, columnName?: string}>} columns - Column metadata
   * @returns {void} Updates internal widths map
   */
  function autoFitColumns(gridWrapEl, tabId, columns) {
    if (!gridWrapEl || !tabId || !columns?.length) return;

    const availableWidth = gridWrapEl.clientWidth - ROW_INDEX_WIDTH;
    if (availableWidth <= 0) return;

    const colNames = columns.map((c) => c?.column_name || c?.columnName || "");
    const colCount = colNames.length;
    if (colCount === 0) return;

    // Phase 1: Compute minimum widths and identify manually-set columns
    const minWidths = [];
    let manualTotal = 0;
    let manualCount = 0;

    for (let i = 0; i < colCount; i++) {
      const name = colNames[i];
      const key = `${tabId}:${name}`;
      if (manuallySet.has(key) && widths[key] != null) {
        minWidths.push(widths[key]);
        manualTotal += widths[key];
        manualCount++;
      } else {
        minWidths.push(headerMinWidth(name));
      }
    }

    const autoCount = colCount - manualCount;
    const remainingForAuto = availableWidth - manualTotal;

    if (autoCount <= 0) {
      // All columns are manual; nothing to auto-fit
      return;
    }

    // Phase 2: Target width per auto column
    const targetAutoWidth = remainingForAuto / autoCount;

    // Phase 3: Clamp auto columns to [min, max]
    const finalWidths = [];
    let autoTotalClamped = 0;

    for (let i = 0; i < colCount; i++) {
      const key = `${tabId}:${colNames[i]}`;
      if (manuallySet.has(key) && widths[key] != null) {
        finalWidths.push(widths[key]);
      } else {
        const clamped = Math.max(minWidths[i], Math.min(MAX_COL_WIDTH, targetAutoWidth));
        finalWidths.push(clamped);
        autoTotalClamped += clamped;
      }
    }

    // Phase 4: If clamped auto total != remaining, distribute the difference
    const autoTotalTarget = remainingForAuto;
    const diff = autoTotalTarget - autoTotalClamped;

    if (Math.abs(diff) > 1 && autoCount > 0) {
      // Redistribute diff proportionally among auto columns
      const perCol = diff / autoCount;
      let distributed = 0;

      for (let i = 0; i < colCount; i++) {
        const key = `${tabId}:${colNames[i]}`;
        if (manuallySet.has(key) && widths[key] != null) continue;

        let adjusted = finalWidths[i] + perCol;
        // Re-clamp
        adjusted = Math.max(minWidths[i], Math.min(MAX_COL_WIDTH, adjusted));
        distributed += adjusted - finalWidths[i];
        finalWidths[i] = adjusted;
      }

      // If there's still a remainder due to clamping, distribute to unclamped columns
      const remainder = autoTotalTarget - (autoTotalClamped + distributed);
      if (Math.abs(remainder) > 1) {
        for (let i = 0; i < colCount && Math.abs(remainder) > 0.5; i++) {
          const key = `${tabId}:${colNames[i]}`;
          if (manuallySet.has(key) && widths[key] != null) continue;
          const canGrow = remainder > 0
            ? MAX_COL_WIDTH - finalWidths[i]
            : finalWidths[i] - minWidths[i];
          if (canGrow <= 0) continue;
          const adjust = remainder > 0 ? Math.min(remainder, canGrow) : Math.max(remainder, -canGrow);
          finalWidths[i] += adjust;
          break; // Simple: just give remainder to first eligible column
        }
      }
    }

    // Phase 5: Store the computed widths
    for (let i = 0; i < colCount; i++) {
      const key = `${tabId}:${colNames[i]}`;
      if (!manuallySet.has(key)) {
        widths[key] = Math.round(finalWidths[i]);
      }
    }
  }

  /**
   * Debounced version of autoFitColumns for resize events.
   */
  function autoFitDebounced(gridWrapEl, tabId, columns) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      autoFitColumns(gridWrapEl, tabId, columns);
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

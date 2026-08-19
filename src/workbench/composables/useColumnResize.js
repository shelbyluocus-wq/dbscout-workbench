import {
  MIN_COL_WIDTH,
  COL_RESIZE_MIN_WIDTH,
  MAX_COL_WIDTH,
  ROW_INDEX_WIDTH,
  AUTOFIT_DEBOUNCE_MS,
} from "../constants.js";
import { calculateColumnWidths } from "../utils/columnWidth.js";
import { columnName } from "../utils/normalize.js";

function validWidth(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

/**
 * Column width state belongs to the table tab rather than the DataGrid
 * component. That keeps manual widths alive when the grid temporarily
 * unmounts for a home/SQL/design tab and lets freeze geometry share the same
 * source of truth.
 */
export function ensureColumnWidthState(tab) {
  if (!tab || typeof tab !== "object") return null;
  const current = tab.columnWidthState;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    tab.columnWidthState = { widths: {}, manual: {}, availableWidth: 0 };
  } else {
    if (!current.widths || typeof current.widths !== "object" || Array.isArray(current.widths)) current.widths = {};
    if (!current.manual || typeof current.manual !== "object" || Array.isArray(current.manual)) current.manual = {};
    if (!Number.isFinite(Number(current.availableWidth))) current.availableWidth = 0;
  }
  return tab.columnWidthState;
}

function fontForElement(element) {
  if (!element || typeof globalThis.getComputedStyle !== "function") return "";
  const style = globalThis.getComputedStyle(element);
  const fontStyle = style.fontStyle || "normal";
  const fontWeight = style.fontWeight || "400";
  const fontSize = style.fontSize || "13px";
  const fontFamily = style.fontFamily || "sans-serif";
  return `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
}

function canvasTextMeasurer(element) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return undefined;
  const context = document.createElement("canvas").getContext?.("2d");
  const font = fontForElement(element);
  if (!context || !font) return undefined;
  context.font = font;
  return (text) => context.measureText(String(text || "")).width;
}

function gridTextMeasurers(gridWrapEl) {
  const grid = gridWrapEl?.querySelector?.(".wb-grid") || gridWrapEl;
  const header = gridWrapEl?.querySelector?.(".wb-grid-column-header-row .wb-th-text") || grid;
  const value = gridWrapEl?.querySelector?.(".wb-grid-row .wb-cell-text") || grid;
  return {
    headerMeasureText: canvasTextMeasurer(header),
    valueMeasureText: canvasTextMeasurer(value),
  };
}

function pruneColumnWidthState(state, columns) {
  const names = new Set((Array.isArray(columns) ? columns : []).map(columnName).filter(Boolean));
  for (const name of Object.keys(state.widths)) {
    if (!names.has(name)) delete state.widths[name];
  }
  for (const name of Object.keys(state.manual)) {
    if (!names.has(name)) delete state.manual[name];
  }
}

/**
 * Manages content-based and manual column widths.
 *
 * Auto widths are calculated from headers, types, and a small row sample after
 * first paint. They do not follow window or pane resizes. Manual widths stay
 * fixed until explicitly reset.
 */
export function useColumnResize() {
  let dragJustEndedAt = 0;
  let debounceTimer = null;
  let autofitRafId = 0;

  function getColumnWidth(tab, colName) {
    return validWidth(ensureColumnWidthState(tab)?.widths?.[colName]);
  }

  function setColumnWidth(tab, colName, px) {
    const state = ensureColumnWidthState(tab);
    const width = validWidth(px);
    if (!state || !colName || width == null) return;
    state.widths[colName] = Math.round(width);
  }

  function isManuallySet(tab, colName) {
    return Boolean(ensureColumnWidthState(tab)?.manual?.[colName]);
  }

  function markManual(tab, colName) {
    const state = ensureColumnWidthState(tab);
    if (state && colName) state.manual[colName] = true;
  }

  function resetColumnWidth(tab, colName) {
    const state = ensureColumnWidthState(tab);
    if (!state || !colName) return;
    delete state.manual[colName];
  }

  function wasDragJustEnded() {
    return Date.now() - dragJustEndedAt < 200;
  }

  function applyColumnWidth(table, colIndex, px) {
    if (!table?.querySelectorAll) return;
    for (const row of table.querySelectorAll("tr")) {
      const cell = row.children[colIndex];
      if (!cell) continue;
      // Pin all three dimensions. With auto table layout and nowrap content,
      // width/min-width alone cannot shrink past the min-content floor.
      cell.style.width = px + "px";
      cell.style.minWidth = px + "px";
      cell.style.maxWidth = px + "px";
    }
  }

  function commitManualWidth(tab, colName, table, colIndex, px) {
    const width = Math.max(COL_RESIZE_MIN_WIDTH, Math.round(Number(px) || COL_RESIZE_MIN_WIDTH));
    applyColumnWidth(table, colIndex, width);
    setColumnWidth(tab, colName, width);
    markManual(tab, colName);
    return width;
  }

  function onHandleMouseDown(event, tab, colName) {
    const th = event.target?.closest?.("th");
    if (!th) return;
    const currentWidth = Math.round(th.getBoundingClientRect().width);
    event.preventDefault();
    event.stopPropagation();

    const table = th.closest("table");
    const colIndex = Array.from(th.parentNode.children).indexOf(th);
    applyColumnWidth(table, colIndex, currentWidth);

    const startX = event.clientX;
    const startWidth = currentWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent) {
      const next = Math.max(COL_RESIZE_MIN_WIDTH, startWidth + moveEvent.clientX - startX);
      applyColumnWidth(table, colIndex, next);
    }

    function onUp() {
      dragJustEndedAt = Date.now();
      commitManualWidth(tab, colName, table, colIndex, parseInt(th.style.width, 10) || startWidth);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onHandleKeyDown(event, tab, colName) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
    const th = event.currentTarget?.closest?.("th");
    if (!th) return false;
    event.preventDefault();
    event.stopPropagation();
    const table = th.closest("table");
    const colIndex = Array.from(th.parentNode.children).indexOf(th);
    const currentWidth = getColumnWidth(tab, colName) || Math.round(th.getBoundingClientRect().width) || MIN_COL_WIDTH;
    const step = event.shiftKey ? 32 : 8;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    commitManualWidth(tab, colName, table, colIndex, currentWidth + direction * step);
    return true;
  }

  function autoFitColumns(gridWrapEl, tab, columns, rows = []) {
    if (!gridWrapEl || !tab || !columns?.length) return;
    const state = ensureColumnWidthState(tab);
    if (!state) return;
    pruneColumnWidthState(state, columns);

    const availableWidth = gridWrapEl.clientWidth - ROW_INDEX_WIDTH;
    if (availableWidth <= 0) return;
    const manualWidths = {};
    for (const column of columns) {
      const name = columnName(column);
      const width = validWidth(state.widths[name]);
      if (name && state.manual[name] && width != null) manualWidths[name] = width;
    }

    const nextWidths = calculateColumnWidths({
      columns,
      rows,
      manualWidths,
      ...gridTextMeasurers(gridWrapEl),
    });
    for (const [name, width] of Object.entries(nextWidths)) {
      if (state.widths[name] !== width) state.widths[name] = width;
    }
    state.availableWidth = availableWidth;
  }

  function autoFitDebounced(gridWrapEl, tab, columns, rows = []) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      autoFitColumns(gridWrapEl, tab, columns, rows);
    }, AUTOFIT_DEBOUNCE_MS);
  }

  function autoFitColumnsRaf(gridWrapEl, tab, columns, rows = []) {
    if (typeof requestAnimationFrame !== "function") {
      autoFitColumns(gridWrapEl, tab, columns, rows);
      return;
    }
    if (autofitRafId) cancelAnimationFrame(autofitRafId);
    autofitRafId = requestAnimationFrame(() => {
      autofitRafId = 0;
      autoFitColumns(gridWrapEl, tab, columns, rows);
    });
  }

  function dispose() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (autofitRafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(autofitRafId);
    debounceTimer = null;
    autofitRafId = 0;
  }

  return {
    getColumnWidth,
    setColumnWidth,
    isManuallySet,
    markManual,
    resetColumnWidth,
    onHandleMouseDown,
    onHandleKeyDown,
    wasDragJustEnded,
    autoFitColumns,
    autoFitColumnsRaf,
    autoFitDebounced,
    dispose,
    MIN_COL_WIDTH,
    MAX_COL_WIDTH,
  };
}

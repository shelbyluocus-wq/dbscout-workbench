const MIN_COL_WIDTH = 60;
const MAX_COL_WIDTH = 600;

export function useColumnResize() {
  const widths = {};
  let dragJustEndedAt = 0;

  function getColumnWidth(tabId, colName) {
    return widths[`${tabId}:${colName}`];
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
      widths[key] = parseInt(th.style.width) || startWidth;
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

  return { getColumnWidth, onHandleMouseDown, wasDragJustEnded, MIN_COL_WIDTH, MAX_COL_WIDTH };
}

export const DEFAULT_COMPARISON_PANE_RATIO = 0.5;
export const MIN_COMPARISON_PANE_RATIO = 0.2;
export const COMPARISON_PANE_RATIO_STORAGE_KEY = "dbscout_batch_compare_pane_ratio_v1";
export const COMPARISON_DETAIL_HEIGHT_STORAGE_KEY = "dbscout_batch_compare_detail_height_v1";
export const COMPARISON_TABLE_NAV_WIDTH_STORAGE_KEY = "dbscout_batch_compare_table_nav_width_v1";
export const DEFAULT_COMPARISON_TABLE_NAV_WIDTH = 196;
export const MIN_COMPARISON_TABLE_NAV_WIDTH = 150;
export const MAX_COMPARISON_TABLE_NAV_WIDTH = 480;
export const MIN_COMPARISON_DETAILS_WIDTH = 360;
const COMPARISON_TABLE_NAV_KEYBOARD_STEP = 16;

export function readStoredComparisonPaneRatio(raw) {
  if (raw == null || raw === "") return DEFAULT_COMPARISON_PANE_RATIO;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampComparisonPaneRatio(stored) : DEFAULT_COMPARISON_PANE_RATIO;
}

export function clampComparisonPaneRatio(ratio, min = MIN_COMPARISON_PANE_RATIO) {
  const value = Number(ratio);
  if (!Number.isFinite(value)) return DEFAULT_COMPARISON_PANE_RATIO;
  const lower = Math.min(Math.max(Number(min) || MIN_COMPARISON_PANE_RATIO, 0.05), 0.45);
  return Math.min(1 - lower, Math.max(lower, value));
}

export function comparisonPaneRatioFromClientX(clientX, rect) {
  const width = Number(rect?.width) || 0;
  if (width <= 0) return DEFAULT_COMPARISON_PANE_RATIO;
  return clampComparisonPaneRatio((Number(clientX) - Number(rect.left || 0)) / width);
}

export function comparisonPaneRatioFromKey(current, key, { shift = false } = {}) {
  if (key === "Home") return DEFAULT_COMPARISON_PANE_RATIO;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return clampComparisonPaneRatio(current);
  const step = shift ? 0.1 : 0.02;
  return clampComparisonPaneRatio(Number(current) + (key === "ArrowRight" ? step : -step));
}

function roundedPaneRatio(ratio) {
  return Math.round(clampComparisonPaneRatio(ratio) * 1000) / 1000;
}

export function comparisonSplitGridStyle(ratio) {
  const left = roundedPaneRatio(ratio);
  return {
    gridTemplateColumns: `minmax(0, ${left}fr) minmax(0, ${Math.round((1 - left) * 1000) / 1000}fr)`,
  };
}

export function comparisonPaneResizerStyle(ratio) {
  const left = roundedPaneRatio(ratio);
  return { left: `calc(${left * 100}% - 3.5px)` };
}

export function clampComparisonTableNavWidth(width, hostWidth = 0) {
  const value = Number(width);
  if (!Number.isFinite(value)) return DEFAULT_COMPARISON_TABLE_NAV_WIDTH;
  const hostMax = Number(hostWidth) > 0
    ? Math.max(MIN_COMPARISON_TABLE_NAV_WIDTH, Math.floor(Number(hostWidth) - MIN_COMPARISON_DETAILS_WIDTH))
    : MAX_COMPARISON_TABLE_NAV_WIDTH;
  const max = Math.min(MAX_COMPARISON_TABLE_NAV_WIDTH, hostMax);
  return Math.round(Math.min(max, Math.max(MIN_COMPARISON_TABLE_NAV_WIDTH, value)));
}

export function readStoredComparisonTableNavWidth(raw, hostWidth = 0) {
  if (raw == null || raw === "") {
    return clampComparisonTableNavWidth(DEFAULT_COMPARISON_TABLE_NAV_WIDTH, hostWidth);
  }
  return clampComparisonTableNavWidth(raw, hostWidth);
}

export function comparisonTableNavWidthFromClientX(clientX, rect) {
  const width = Number(rect?.width) || 0;
  if (width <= 0) return DEFAULT_COMPARISON_TABLE_NAV_WIDTH;
  return clampComparisonTableNavWidth(Number(clientX) - Number(rect.left || 0), width);
}

export function comparisonTableNavWidthFromKey(current, key, { shift = false, hostWidth = 0 } = {}) {
  if (key === "Home") return clampComparisonTableNavWidth(DEFAULT_COMPARISON_TABLE_NAV_WIDTH, hostWidth);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return clampComparisonTableNavWidth(current, hostWidth);
  const step = shift ? COMPARISON_TABLE_NAV_KEYBOARD_STEP * 3 : COMPARISON_TABLE_NAV_KEYBOARD_STEP;
  return clampComparisonTableNavWidth(
    Number(current) + (key === "ArrowRight" ? step : -step),
    hostWidth,
  );
}

export function comparisonTableNavGridStyle(width, hostWidth = 0) {
  const px = clampComparisonTableNavWidth(width, hostWidth);
  return {
    gridTemplateColumns: `${px}px minmax(0, 1fr)`,
  };
}

export function comparisonTableNavResizerStyle(width, hostWidth = 0) {
  const px = clampComparisonTableNavWidth(width, hostWidth);
  return { left: `${px - 3.5}px` };
}

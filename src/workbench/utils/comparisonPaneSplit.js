export const DEFAULT_COMPARISON_PANE_RATIO = 0.5;
export const MIN_COMPARISON_PANE_RATIO = 0.2;
export const COMPARISON_PANE_RATIO_STORAGE_KEY = "dbscout_batch_compare_pane_ratio_v1";
export const COMPARISON_DETAIL_HEIGHT_STORAGE_KEY = "dbscout_batch_compare_detail_height_v1";

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

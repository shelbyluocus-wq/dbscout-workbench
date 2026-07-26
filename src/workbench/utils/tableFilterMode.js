export const DEFAULT_TABLE_FILTER_MODE = "continuous";

const TABLE_FILTER_MODES = new Set(["exact", "continuous", "fuzzy"]);

export function normalizeTableFilterMode(mode) {
  const normalized = String(mode || "").toLowerCase();
  return TABLE_FILTER_MODES.has(normalized) ? normalized : DEFAULT_TABLE_FILTER_MODE;
}

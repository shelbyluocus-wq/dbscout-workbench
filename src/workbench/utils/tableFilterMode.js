export const DEFAULT_TABLE_FILTER_MODE = "exact";

export function normalizeTableFilterMode(mode) {
  return String(mode || "").toLowerCase() === "fuzzy" ? "fuzzy" : DEFAULT_TABLE_FILTER_MODE;
}

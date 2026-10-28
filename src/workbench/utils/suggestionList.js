/**
 * Choices for a text field with a suggestion list. Opening a filled field
 * (`browsing`) shows every option, so a value already in the box does not
 * hide the rest. Typing filters.
 */
function optionSearchText(option) {
  if (option && typeof option === "object") return `${option.label ?? ""} ${option.value ?? ""}`;
  return String(option);
}

export function suggestionMatches(options, query, { browsing = false, limit = 80 } = {}) {
  const list = Array.isArray(options) ? options : [];
  const cap = Number.isFinite(limit) ? Math.max(0, limit) : list.length;
  const needle = browsing ? "" : String(query ?? "").trim().toLowerCase();
  if (!needle) return list.slice(0, cap);
  return list.filter((option) => optionSearchText(option).toLowerCase().includes(needle)).slice(0, cap);
}

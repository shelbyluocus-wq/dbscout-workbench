function scalarText(value) {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function auditRowSummary(entry, maxLength = 240) {
  const operation = String(entry?.operation || "").toUpperCase();
  const raw = operation === "INSERT" ? entry?.newValue : operation === "DELETE" ? entry?.oldValue : null;
  if (raw == null || raw === "") return "";

  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }

  const text = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, item]) => `${key}=${scalarText(item)}`).join("，")
    : scalarText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function auditRowSummaryLabel(operation) {
  return String(operation || "").toUpperCase() === "DELETE" ? "删除内容" : "新增内容";
}

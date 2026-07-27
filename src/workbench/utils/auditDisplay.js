function scalarText(value) {
  if (value === null) return "NULL";
  if (value === undefined) return "未设置";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parsedValue(raw) {
  if (raw == null || raw === "") return raw;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sameValue(left, right) {
  return scalarText(left) === scalarText(right);
}

function cleanDescription(value) {
  return String(value || "")
    .replace(/^[\s✏️🗑️🔧➕🔑]+/u, "")
    .trim();
}

function ddlItemsFromSql(sql) {
  const text = String(sql || "");
  if (!text.trim()) return [];

  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || seen.has(item)) return;
    seen.add(item);
    items.push(item);
  };
  const collect = (pattern, formatter) => {
    for (const match of text.matchAll(pattern)) push(formatter(match));
  };

  collect(/\bADD\s+COLUMN\s+`([^`]+)`/gi, (match) => `新增字段「${match[1]}」`);
  collect(/\bDROP\s+COLUMN\s+`([^`]+)`/gi, (match) => `删除字段「${match[1]}」`);
  collect(/\bCHANGE\s+COLUMN\s+`([^`]+)`\s+`([^`]+)`/gi, (match) =>
    match[1] === match[2]
      ? `修改字段「${match[2]}」定义`
      : `字段重命名「${match[1]}」→「${match[2]}」`,
  );
  collect(/\bMODIFY\s+COLUMN\s+`([^`]+)`/gi, (match) => `修改字段「${match[1]}」定义`);
  if (/\bDROP\s+PRIMARY\s+KEY\b/i.test(text)) push("取消主键");
  if (/\bADD\s+PRIMARY\s+KEY\b/i.test(text)) push("新增主键");
  if (/\bALTER\s+TABLE\b[\s\S]*\bCOMMENT\s*=/i.test(text)) push("修改表备注");
  if (/\bRENAME\s+TABLE\b/i.test(text)) push("重命名表");
  if (/\bDROP\s+TABLE\b/i.test(text)) push("删除表");

  return items;
}

function objectChangeItems(oldValue, newValue) {
  const oldObject = oldValue && typeof oldValue === "object" && !Array.isArray(oldValue)
    ? oldValue
    : null;
  const newObject = newValue && typeof newValue === "object" && !Array.isArray(newValue)
    ? newValue
    : null;
  if (!oldObject && !newObject) return [];

  const keys = new Set([
    ...Object.keys(oldObject || {}),
    ...Object.keys(newObject || {}),
  ]);
  const items = [];
  for (const key of keys) {
    const before = oldObject?.[key];
    const after = newObject?.[key];
    if (sameValue(before, after)) continue;
    items.push(`${key}：${scalarText(before)} → ${scalarText(after)}`);
  }
  return items;
}

export function auditChangeItems(entry) {
  const operation = String(entry?.operation || "").toUpperCase();
  const oldValue = parsedValue(entry?.oldValue);
  const newValue = parsedValue(entry?.newValue);

  if (operation === "DDL") {
    if (Array.isArray(newValue)) {
      const descriptions = newValue.map(cleanDescription).filter(Boolean);
      if (descriptions.length) return descriptions;
    }
    if (entry?.oldValue != null && entry?.newValue != null && !Array.isArray(newValue)) {
      return [`重命名表：${scalarText(oldValue)} → ${scalarText(newValue)}`];
    }
    if (entry?.oldValue != null && entry?.newValue == null && /\bDROP\s+TABLE\b/i.test(entry?.forwardSql || "")) {
      return [`删除表「${scalarText(oldValue)}」`];
    }
    return ddlItemsFromSql(entry?.forwardSql);
  }

  if (operation === "INSERT" || operation === "DELETE") {
    const value = operation === "INSERT" ? newValue : oldValue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).map(([key, item]) => `${key}=${scalarText(item)}`);
    }
    return value == null || value === "" ? [] : [scalarText(value)];
  }

  if (entry?.columnName) {
    return [`${entry.columnName}：${scalarText(oldValue)} → ${scalarText(newValue)}`];
  }

  const groupedItems = objectChangeItems(oldValue, newValue);
  if (groupedItems.length) return groupedItems;
  if (entry?.oldValue != null || entry?.newValue != null) {
    return [`${scalarText(oldValue)} → ${scalarText(newValue)}`];
  }
  return [];
}

export function auditChangeSummary(entry, maxLength = 120) {
  const text = auditChangeItems(entry).join("；");
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function auditChangeSql(entry) {
  return String(entry?.operation || "").toUpperCase() === "DDL"
    ? String(entry?.forwardSql || "").trim()
    : "";
}

export function auditHasDetails(entry, summaryLength = 48) {
  const items = auditChangeItems(entry);
  const fullSummary = items.join("；");
  return Boolean(
    auditChangeSql(entry) ||
    entry?.notes ||
    items.length > 1 ||
    fullSummary.length > summaryLength
  );
}

export function auditRowSummary(entry, maxLength = 240) {
  const operation = String(entry?.operation || "").toUpperCase();
  const raw = operation === "INSERT" ? entry?.newValue : operation === "DELETE" ? entry?.oldValue : null;
  if (raw == null || raw === "") return "";

  const value = parsedValue(raw);

  const text = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, item]) => `${key}=${scalarText(item)}`).join("，")
    : scalarText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function auditRowSummaryLabel(operation) {
  return String(operation || "").toUpperCase() === "DELETE" ? "删除内容" : "新增内容";
}

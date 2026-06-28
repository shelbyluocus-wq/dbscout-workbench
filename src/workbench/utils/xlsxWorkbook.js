export function safeExcelSheetName(value, fallback = "Sheet") {
  const cleaned = String(value || fallback)
    .replace(/[\[\]:*?/\\]/g, "_")
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

export function safeExcelFileStem(value, fallback = "table") {
  return String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || fallback;
}

export function worksheetToDisplayRows(XLSX, worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
}

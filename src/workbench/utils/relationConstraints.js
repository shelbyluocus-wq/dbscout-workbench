// Discriminators are part of a relation's meaning, not optional UI filters.
export function normalizeRelationConstraints(constraints) {
  if (!Array.isArray(constraints)) return [];
  return constraints.map((guard) => ({
    column: String(guard?.column ?? "").trim(),
    values: Array.isArray(guard?.values) ? [...new Set(guard.values.map((value) => String(value ?? "").trim()))] : [],
  }));
}

export function matchesRelationConstraints(row, constraints) {
  return normalizeRelationConstraints(constraints).every((guard) => {
    const key = Object.keys(row || {}).find((key) => key.toLowerCase() === guard.column.toLowerCase());
    return key !== undefined && guard.values.includes(String(row[key] ?? "").trim());
  });
}

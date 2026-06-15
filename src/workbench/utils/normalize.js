export function normalizeTableName(table) {
  return table?.table_name || table?.tableName || "";
}

export function normalizeTableComment(table) {
  return table?.table_comment || table?.tableComment || "";
}

export function columnName(column) {
  return column?.column_name || column?.columnName || "";
}

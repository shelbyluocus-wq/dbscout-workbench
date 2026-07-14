export const SQL_KEYWORDS = Object.freeze([
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
  "ON", "AS", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "DISTINCT",
  "UNION", "UNION ALL", "WITH", "CASE", "WHEN", "THEN", "ELSE", "END",
  "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE",
  "ALTER TABLE", "DROP TABLE", "TRUNCATE TABLE", "CREATE INDEX", "DROP INDEX",
  "EXPLAIN", "SHOW", "DESCRIBE", "USE", "BEGIN", "COMMIT", "ROLLBACK",
]);

export const SQL_FUNCTIONS = Object.freeze([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "NOW", "CURDATE", "DATE_FORMAT",
  "COALESCE", "IFNULL", "CONCAT", "LOWER", "UPPER", "ROUND", "JSON_EXTRACT",
]);

export function buildSqlCompletionOptions(schema = [], databases = []) {
  const options = [
    ...SQL_KEYWORDS.map((label) => ({ label, type: "keyword" })),
    ...SQL_FUNCTIONS.map((label) => ({ label, type: "function" })),
    ...databases.filter(Boolean).map((label) => ({ label, type: "namespace", detail: "数据库" })),
  ];

  for (const table of schema || []) {
    const tableName = table.table_name || table.tableName || table.name;
    if (tableName) options.push({ label: tableName, type: "class", detail: "表" });
    for (const column of table.columns || []) {
      const name = column.column_name || column.columnName || column.name;
      if (name) options.push({ label: name, type: "property", detail: tableName || "字段" });
    }
  }
  return options;
}

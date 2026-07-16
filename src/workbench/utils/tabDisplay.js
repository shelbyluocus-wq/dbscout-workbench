export function formatTableTabTitle(tab = {}, databaseDisplayName = "") {
  const database = String(databaseDisplayName || tab.database || "").trim();
  const tableName = String(tab.tableName || "").trim();
  if (!database) return tableName;
  if (!tableName) return database;
  return `${tableName} @${database}`;
}

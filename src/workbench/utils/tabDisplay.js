import { t } from "../i18n/index.js";

export function formatTableTabTitle(tab = {}, databaseDisplayName = "") {
  const database = String(databaseDisplayName || tab.database || "").trim();
  const tableName = tab.createMode ? String(tab.draft?.tableName || t("createTable.title")) : String(tab.tableName || "").trim();
  if (!database) return tableName;
  if (!tableName) return database;
  return `${tableName} @${database}`;
}

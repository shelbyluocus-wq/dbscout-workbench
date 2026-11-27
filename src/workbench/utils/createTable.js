import { t } from "../i18n/index.js";
import { buildTableDesignPayload, validateTableDesignDraft } from "./tableDesign.js";

export function initialCreateTableDraft() {
  return {
    tableName: "",
    tableComment: "",
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_general_ci",
    columns: [{
      id: "new-id",
      originalName: "",
      name: "ID",
      type: "int",
      length: "",
      scale: "",
      originalType: "",
      unsigned: false,
      autoIncrement: false,
      nullable: false,
      primaryKey: true,
      primaryKeyOrdinal: 1,
      defaultMode: "none",
      defaultValue: "",
      comment: "",
    }],
    indexes: [],
  };
}

export function validateCreateTableDraft(draft) {
  const result = validateTableDesignDraft(draft);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(draft.tableName || ""))) {
    result.valid = false;
    result.messages.unshift(t("createTable.invalidName"));
  }
  return result;
}

export function createTablePayload(source, draft) {
  return buildTableDesignPayload({ ...source, tableName: draft.tableName }, draft);
}

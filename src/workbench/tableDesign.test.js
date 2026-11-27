import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTableDesignPayload,
  displayColumnType,
  normalizeTableDesign,
  parseColumnType,
  validateTableDesignDraft,
} from "./utils/tableDesign.js";

test("type changes reject inherited literal defaults for text, blob and JSON", () => {
  for (const type of ["tinytext", "text", "mediumtext", "longtext", "tinyblob", "blob", "mediumblob", "longblob", "json"]) {
    const draft = normalizeTableDesign({
      table_name: "guideprop",
      columns: [{ column_name: "CustomGroupID", column_type: "int", column_default: "0", is_nullable: false }],
    });
    draft.columns[0].type = type;
    for (const value of ["0", ""]) {
      draft.columns[0].defaultValue = value;
      const validation = validateTableDesignDraft(draft);
      assert.equal(validation.valid, false, `${type} default ${JSON.stringify(value)}`);
      assert.match(validation.columns[0].defaultMode, /默认值/);
    }
    draft.columns[0].defaultMode = "none";
    assert.equal(validateTableDesignDraft(draft).valid, true);
    draft.columns[0].nullable = true;
    draft.columns[0].defaultMode = "null";
    assert.equal(validateTableDesignDraft(draft).valid, true);
  }
});

test("parseColumnType reads varchar length and displays it", () => {
  const parsed = parseColumnType("varchar(64)");

  assert.equal(parsed.type, "varchar");
  assert.equal(parsed.length, "64");
  assert.equal(parsed.scale, "");
  assert.equal(parsed.originalType, "varchar(64)");
  assert.equal(displayColumnType(parsed), "varchar(64)");
});

test("parseColumnType reads decimal precision and scale", () => {
  const parsed = parseColumnType("decimal(10,2)");

  assert.equal(parsed.type, "decimal");
  assert.equal(parsed.length, "10");
  assert.equal(parsed.scale, "2");
  assert.equal(displayColumnType(parsed), "decimal(10,2)");
});

test("normalizeTableDesign recognizes MySQL numeric types with modifiers", () => {
  const draft = normalizeTableDesign({
    table_name: "props",
    columns: [
      {
        column_name: "CondGetType",
        column_type: "tinyint(3) unsigned",
        data_type: "tinyint",
        numeric_precision: 3,
        numeric_scale: 0,
        is_nullable: "YES",
      },
    ],
  });

  assert.equal(draft.columns[0].type, "tinyint");
  assert.equal(draft.columns[0].length, "3");
  assert.equal(validateTableDesignDraft(draft).valid, true);
});

test("normalizeTableDesign accepts MySQL 8.4 integer modifiers without display widths", () => {
  const draft = normalizeTableDesign({
    table_name: "fazhenprop",
    columns: [
      {
        column_name: "ID",
        column_type: "int unsigned",
        data_type: "int",
        is_nullable: false,
        is_primary_key: true,
      },
      {
        column_name: "LvlMax",
        column_type: "smallint unsigned",
        data_type: "smallint",
        is_nullable: false,
      },
      {
        column_name: "LvlScore",
        column_type: "smallint unsigned zerofill",
        data_type: "smallint",
        is_nullable: false,
      },
    ],
  });

  assert.deepEqual(draft.columns.map((column) => column.type), ["int", "smallint", "smallint"]);
  assert.deepEqual(
    draft.columns.map((column) => column.originalType),
    ["int unsigned", "smallint unsigned", "smallint unsigned zerofill"],
  );
  assert.equal(validateTableDesignDraft(draft).valid, true);
});

test("parseColumnType keeps plain and unsupported types usable", () => {
  const plain = parseColumnType("datetime");
  const unsupported = parseColumnType("geometrycollection SRID 4326");

  assert.equal(plain.type, "datetime");
  assert.equal(displayColumnType(plain), "datetime");
  assert.equal(unsupported.type, "geometrycollection SRID 4326");
  assert.equal(unsupported.originalType, "geometrycollection SRID 4326");
  assert.equal(displayColumnType(unsupported), "geometrycollection SRID 4326");
});

test("normalizeTableDesign builds an editable draft from backend metadata", () => {
  const draft = normalizeTableDesign({
    table_name: "items",
    table_comment: "道具表",
    columns: [
      {
        column_name: "id",
        column_type: "bigint",
        is_nullable: false,
        is_primary_key: true,
        column_default: null,
        column_comment: "主键",
      },
      {
        column_name: "name",
        data_type: "varchar",
        character_maximum_length: 64,
        is_nullable: "YES",
        column_default: "",
        column_comment: "名称",
      },
    ],
  });

  assert.equal(draft.tableName, "items");
  assert.equal(draft.tableComment, "道具表");
  assert.deepEqual(
    draft.columns.map((column) => ({
      name: column.name,
      type: column.type,
      length: column.length,
      nullable: column.nullable,
      primaryKey: column.primaryKey,
      defaultMode: column.defaultMode,
      defaultValue: column.defaultValue,
      comment: column.comment,
    })),
    [
      {
        name: "id",
        type: "bigint",
        length: "",
        nullable: false,
        primaryKey: true,
        defaultMode: "none",
        defaultValue: "",
        comment: "主键",
      },
      {
        name: "name",
        type: "varchar",
        length: "64",
        nullable: true,
        primaryKey: false,
        defaultMode: "value",
        defaultValue: "",
        comment: "名称",
      },
    ],
  );
});

test("validateTableDesignDraft reports empty and duplicate field names", () => {
  const result = validateTableDesignDraft({
    tableComment: "",
    columns: [
      { name: "", type: "int", length: "", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
      { name: "Name", type: "varchar", length: "64", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
      { name: "name", type: "varchar", length: "64", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
    ],
  });

  assert.equal(result.valid, false);
  assert.equal(result.columns[0].name, "字段名不能为空");
  assert.equal(result.columns[1].name, "字段名不能重复");
  assert.equal(result.columns[2].name, "字段名不能重复");
});

test("validateTableDesignDraft validates type, length, primary key nullability, and defaults", () => {
  const result = validateTableDesignDraft({
    tableComment: "",
    columns: [
      { name: "sku", type: "varchar", length: "0", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
      { name: "price", type: "decimal", length: "10", scale: "bad", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
      { name: "id", type: "bigint", length: "", nullable: true, primaryKey: true, defaultMode: "null", defaultValue: "" },
      { name: "status", type: "", length: "", nullable: true, primaryKey: false, defaultMode: "expression", defaultValue: "" },
    ],
  });

  assert.equal(result.valid, false);
  assert.equal(result.columns[0].length, "长度必须是正整数");
  assert.equal(result.columns[1].scale, "小数位必须是非负整数");
  assert.equal(result.columns[2].nullable, "主键字段必须为非空");
  assert.equal(result.columns[2].defaultValue, "主键字段不能使用 NULL 默认值");
  assert.equal(result.columns[3].type, "请选择字段类型");
  assert.equal(result.columns[3].defaultValue, "默认表达式不能为空");
});

test("validateTableDesignDraft rejects unsafe type strings", () => {
  const result = validateTableDesignDraft({
    tableComment: "",
    columns: [
      { name: "name", type: "varchar); DROP TABLE x; --", length: "64", scale: "", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
    ],
  });

  assert.equal(result.valid, false);
  assert.match(result.columns[0].type, /类型/);
});

test("validateTableDesignDraft rejects non-finite and invalid numeric fields", () => {
  const result = validateTableDesignDraft({
    tableComment: "",
    columns: [
      { name: "name", type: "varchar", length: Infinity, scale: "", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
      { name: "price", type: "decimal", length: "1e309", scale: NaN, nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "" },
    ],
  });

  assert.equal(result.valid, false);
  assert.equal(result.columns[0].length, "长度必须是正整数");
  assert.equal(result.columns[1].length, "精度必须是正整数");
  assert.equal(result.columns[1].scale, "小数位必须是非负整数");
});

test("buildTableDesignPayload never emits non-finite numbers", () => {
  const payload = buildTableDesignPayload(
    { connectionId: "mysql-1", database: "game", tableName: "items" },
    {
      tableComment: "道具配置",
      columns: [
        { name: "name", type: "varchar", length: Infinity, scale: "", nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "", comment: "" },
        { name: "price", type: "decimal", length: "1e309", scale: NaN, nullable: true, primaryKey: false, defaultMode: "none", defaultValue: "", comment: "" },
      ],
    },
  );

  assert.equal(payload.draft.columns[0].length, null);
  assert.equal(payload.draft.columns[0].scale, null);
  assert.equal(payload.draft.columns[1].length, null);
  assert.equal(payload.draft.columns[1].scale, null);
});

test("buildTableDesignPayload includes source identity and normalized column changes", () => {
  const payload = buildTableDesignPayload(
    { connectionId: "mysql-1", database: "game", tableName: "items" },
    {
      tableComment: "道具配置",
      columns: [
        { name: "id", type: "bigint", length: "", scale: "", nullable: false, primaryKey: true, primaryKeyOrdinal: 1, defaultMode: "none", defaultValue: "", comment: "主键" },
        { name: "price", type: "decimal", length: "10", scale: "2", nullable: false, primaryKey: false, defaultMode: "value", defaultValue: "0.00", comment: "售价" },
      ],
    },
  );

  assert.deepEqual(payload, {
    connectionId: "mysql-1",
    database: "game",
    tableName: "items",
    draft: {
      tableComment: "道具配置",
      columns: [
        { originalName: "id", name: "id", type: "bigint", length: null, scale: null, unsigned: false, nullable: false, primaryKey: true, primaryKeyOrdinal: 1, autoIncrement: false, defaultMode: "none", defaultValue: null, comment: "主键" },
        { originalName: "price", name: "price", type: "decimal", length: 10, scale: 2, unsigned: false, nullable: false, primaryKey: false, primaryKeyOrdinal: null, autoIncrement: false, defaultMode: "value", defaultValue: "0.00", comment: "售价" },
      ],
    },
  });
});

test("normalizeTableDesign preserves composite primary-key order independently from column order", () => {
  const draft = normalizeTableDesign({
    columns: [
      { column_name: "tenant_id", column_type: "bigint", is_primary_key: true, primary_key_ordinal: 2 },
      { column_name: "record_id", column_type: "bigint", is_primary_key: true, primary_key_ordinal: 1 },
      { column_name: "label", column_type: "varchar(32)", is_primary_key: false },
    ],
  });

  assert.equal(draft.columns[0].primaryKeyOrdinal, 2);
  assert.equal(draft.columns[1].primaryKeyOrdinal, 1);
  const payload = buildTableDesignPayload({ tableName: "records" }, draft);
  assert.deepEqual(
    payload.draft.columns.map((column) => column.primaryKeyOrdinal),
    [2, 1, null],
  );
});

test("normalizeTableDesign assigns legacy primary keys a stable consecutive order", () => {
  const draft = normalizeTableDesign({
    columns: [
      { column_name: "tenant_id", column_type: "bigint", is_primary_key: true },
      { column_name: "record_id", column_type: "bigint", is_primary_key: true },
    ],
  });

  assert.deepEqual(draft.columns.map((column) => column.primaryKeyOrdinal), [1, 2]);
  assert.equal(validateTableDesignDraft(draft).valid, true);
});

test("validateTableDesignDraft enforces autoIncrement and unsigned rules", () => {
  const result = validateTableDesignDraft({
    columns: [
      { name: "id", type: "varchar", length: "64", scale: "", unsigned: true, nullable: true, primaryKey: true, primaryKeyOrdinal: 1, autoIncrement: true, defaultMode: "value", defaultValue: "1", comment: "" },
      { name: "seq", type: "int", length: "", scale: "", unsigned: false, nullable: false, primaryKey: false, autoIncrement: true, defaultMode: "none", defaultValue: "", comment: "" },
    ],
    indexes: [],
  });
  assert.ok(result.messages.some((err) => err.includes("自增") || err.includes("auto") || err.includes("整数")));
  assert.ok(result.messages.some((err) => err.includes("1 个自增") || err.includes("one auto") || err.includes("自增")));
});

test("validateTableDesignDraft and buildTableDesignPayload support secondary indexes and table options", () => {
  const draft = {
    tableComment: "玩家",
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_unicode_ci",
    columns: [
      { name: "id", type: "bigint", length: "", scale: "", unsigned: true, nullable: false, primaryKey: true, primaryKeyOrdinal: 1, autoIncrement: true, defaultMode: "none", defaultValue: "", comment: "" },
      { name: "email", type: "varchar", length: "120", scale: "", unsigned: false, nullable: false, primaryKey: false, defaultMode: "none", defaultValue: "", comment: "" },
    ],
    indexes: [
      { originalName: "idx_email", name: "idx_email", indexType: "UNIQUE", columns: ["email"], comment: "邮箱唯一" },
    ],
  };
  const validation = validateTableDesignDraft(draft);
  assert.equal(validation.valid, true);
  const payload = buildTableDesignPayload(
    { connectionId: "mysql-1", database: "game", tableName: "players" },
    draft,
  );
  assert.equal(payload.draft.engine, "InnoDB");
  assert.equal(payload.draft.charset, "utf8mb4");
  assert.equal(payload.draft.collation, "utf8mb4_unicode_ci");
  assert.equal(payload.draft.columns[0].unsigned, true);
  assert.equal(payload.draft.columns[0].autoIncrement, true);
  assert.deepEqual(payload.draft.indexes, [
    { originalName: "idx_email", name: "idx_email", indexType: "UNIQUE", columns: ["email"], comment: "邮箱唯一" },
  ]);
});

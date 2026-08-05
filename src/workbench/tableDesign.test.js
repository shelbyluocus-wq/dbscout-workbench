import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTableDesignPayload,
  displayColumnType,
  normalizeTableDesign,
  parseColumnType,
  validateTableDesignDraft,
} from "./utils/tableDesign.js";

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
        { name: "id", type: "bigint", length: "", scale: "", nullable: false, primaryKey: true, defaultMode: "none", defaultValue: "", comment: "主键" },
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
        { originalName: "id", name: "id", type: "bigint", length: null, scale: null, nullable: false, primaryKey: true, defaultMode: "none", defaultValue: null, comment: "主键" },
        { originalName: "price", name: "price", type: "decimal", length: 10, scale: 2, nullable: false, primaryKey: false, defaultMode: "value", defaultValue: "0.00", comment: "售价" },
      ],
    },
  });
});

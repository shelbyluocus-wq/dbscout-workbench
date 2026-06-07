import test from "node:test";
import assert from "node:assert/strict";
import {
  columnConstraint,
  validateCellValue,
  validateRowDraft,
  validateBatchEdits,
} from "./utils/valueValidation.js";

function col(name, type, extra = {}) {
  return {
    column_name: name,
    column_type: type,
    data_type: type.split("(")[0].toLowerCase(),
    is_primary_key: false,
    is_nullable: true,
    column_comment: "",
    ...extra,
  };
}

function table(columns) {
  return {
    table_name: "sample",
    columns,
    primaryKeys: columns.filter((c) => c.is_primary_key).map((c) => c.column_name),
  };
}

test("columnConstraint parses varchar length, decimal precision, enum values, and unsigned", () => {
  assert.deepEqual(columnConstraint(col("name", "varchar(32)")), {
    name: "name",
    type: "varchar",
    nullable: true,
    primaryKey: false,
    maxLength: 32,
    precision: null,
    scale: null,
    unsigned: false,
    enumValues: [],
    setValues: [],
  });
  assert.deepEqual(columnConstraint(col("price", "decimal(8,2)")), {
    name: "price",
    type: "decimal",
    nullable: true,
    primaryKey: false,
    maxLength: null,
    precision: 8,
    scale: 2,
    unsigned: false,
    enumValues: [],
    setValues: [],
  });
  assert.deepEqual(columnConstraint(col("status", "enum('open','closed')")), {
    name: "status",
    type: "enum",
    nullable: true,
    primaryKey: false,
    maxLength: null,
    precision: null,
    scale: null,
    unsigned: false,
    enumValues: ["open", "closed"],
    setValues: [],
  });
  assert.equal(columnConstraint(col("count", "int unsigned")).unsigned, true);
});

test("validateCellValue rejects duplicate primary key updates", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false }),
    col("name", "varchar(32)"),
  ]);
  const rows = [{ id: "1", name: "a" }, { id: "2", name: "b" }];
  const result = validateCellValue({ table: meta, rows, row: rows[0], columnName: "id", value: "2" });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "duplicate-primary-key");
  assert.equal(result.errors[0].shortMessage, "主键重复");
});

test("validateCellValue rejects invalid scalar values", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false }),
    col("age", "int", { is_nullable: false }),
    col("price", "decimal(5,2)"),
    col("name", "varchar(4)"),
    col("payload", "json"),
    col("starts_at", "datetime"),
    col("enabled", "boolean"),
    col("score", "float"),
    col("kind", "enum('a','b')"),
    col("flags", "set('x','y')"),
    col("birthday", "date"),
    col("duration", "time"),
    col("created_at", "timestamp"),
    col("season", "year"),
    col("count", "int unsigned"),
  ]);
  const row = { id: "1", age: "10", price: "12.34", name: "ok", payload: "{}", starts_at: "2026-01-01 10:00:00", enabled: "1" };
  const rows = [row];
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "age", value: "abc" }).errors[0].code, "invalid-integer");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "age", value: "" }).errors[0].code, "required");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "price", value: "1234.56" }).errors[0].code, "decimal-precision");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "price", value: "12.345" }).errors[0].code, "decimal-scale");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "name", value: "abcde" }).errors[0].code, "length-overflow");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "payload", value: "{bad}" }).errors[0].code, "invalid-json");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "starts_at", value: "hello" }).errors[0].code, "invalid-datetime");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "enabled", value: "maybe" }).errors[0].code, "invalid-boolean");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "score", value: "not-a-number" }).errors[0].code, "invalid-float");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "kind", value: "c" }).errors[0].code, "invalid-enum");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "flags", value: "x,z" }).errors[0].code, "invalid-set");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "birthday", value: "2026/01/01" }).errors[0].code, "invalid-date");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "duration", value: "99" }).errors[0].code, "invalid-time");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "created_at", value: "2026-01-01" }).errors[0].code, "invalid-timestamp");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "season", value: "26" }).errors[0].code, "invalid-year");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "count", value: "-1" }).errors[0].code, "integer-range");
});

test("validateRowDraft rejects duplicate composite primary keys and missing required fields", () => {
  const meta = table([
    col("account_id", "int", { is_primary_key: true, is_nullable: false }),
    col("role_id", "int", { is_primary_key: true, is_nullable: false }),
    col("label", "varchar(8)", { is_nullable: false }),
  ]);
  const rows = [{ account_id: "1", role_id: "7", label: "admin" }];
  const duplicate = validateRowDraft({ table: meta, rows, draft: { account_id: "1", role_id: "7", label: "copy" } });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.errors[0].code, "duplicate-primary-key");
  const missing = validateRowDraft({ table: meta, rows, draft: { account_id: "2", role_id: "8" } });
  assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].code, "required");
});

test("validateBatchEdits returns valid and invalid edit partitions", () => {
  const meta = table([col("id", "int", { is_primary_key: true, is_nullable: false }), col("age", "int")]);
  const rows = [{ id: "1", age: "10" }, { id: "2", age: "20" }];
  const result = validateBatchEdits({
    table: meta,
    rows,
    edits: [
      { row: rows[0], rowIndex: 0, columnName: "age", value: "11" },
      { row: rows[1], rowIndex: 1, columnName: "age", value: "bad" },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(result.validEdits.length, 1);
  assert.equal(result.errors[0].code, "invalid-integer");
});

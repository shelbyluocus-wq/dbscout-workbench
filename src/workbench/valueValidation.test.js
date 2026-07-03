import test from "node:test";
import assert from "node:assert/strict";
import {
  clearedCellValue,
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

test("clearedCellValue writes an empty string for text/blob columns", () => {
  assert.deepEqual(clearedCellValue(col("name", "varchar(32)")), { value: "", canClear: true });
  assert.deepEqual(clearedCellValue(col("bio", "text")), { value: "", canClear: true });
  assert.deepEqual(clearedCellValue(col("blob_col", "longblob")), { value: "", canClear: true });
});

test("clearedCellValue writes NULL for nullable non-text columns", () => {
  assert.deepEqual(clearedCellValue(col("level", "int", { is_nullable: true })), { value: null, canClear: true });
  assert.deepEqual(clearedCellValue(col("born", "date", { is_nullable: true })), { value: null, canClear: true });
});

test("clearedCellValue cannot clear NOT NULL non-text columns", () => {
  assert.deepEqual(clearedCellValue(col("level", "int", { is_nullable: false })), { value: null, canClear: false });
});

test("clearedCellValue never clears primary key columns", () => {
  assert.deepEqual(
    clearedCellValue(col("id", "varchar(16)", { is_primary_key: true, is_nullable: false })),
    { value: null, canClear: false },
  );
});

test("columnConstraint parses varchar length, decimal precision, enum values, and unsigned", () => {  assert.deepEqual(columnConstraint(col("name", "varchar(32)")), {
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
    isAutoIncrement: false,
    isGenerated: false,
    defaultMode: "",
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
    isAutoIncrement: false,
    isGenerated: false,
    defaultMode: "",
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
    isAutoIncrement: false,
    isGenerated: false,
    defaultMode: "",
  });
  assert.equal(columnConstraint(col("count", "int unsigned")).unsigned, true);
});

test("validateCellValue accepts mixed-case enum and set values", () => {
  const meta = table([
    col("status", "enum('Open','Closed')"),
    col("flags", "set('Read','Write')"),
  ]);
  const row = { status: "Open", flags: "Read" };
  const rows = [row];

  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "status", value: "Open" }).valid, true);
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "flags", value: "Read,Write" }).valid, true);
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

test("validateCellValue accepts fractional decimal values within precision", () => {
  const meta = table([col("ratio", "decimal(3,3)")]);
  const row = { ratio: "0.001" };
  const rows = [row];

  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "ratio", value: "0.123" }).valid, true);
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "ratio", value: ".123" }).valid, true);
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
    col("tiny_enabled", "tinyint(1)"),
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
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "price", value: "1234.5" }).errors[0].code, "decimal-precision");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "price", value: "12.345" }).errors[0].code, "decimal-scale");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "name", value: "abcde" }).errors[0].code, "length-overflow");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "payload", value: "{bad}" }).errors[0].code, "invalid-json");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "starts_at", value: "hello" }).errors[0].code, "invalid-datetime");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "enabled", value: "maybe" }).errors[0].code, "invalid-boolean");
  assert.equal(validateCellValue({ table: meta, rows, row, columnName: "tiny_enabled", value: "2" }).errors[0].code, "invalid-boolean");
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

test("validateRowDraft merges incomplete explicit primaryKeys with composite column metadata", () => {
  const meta = table([
    col("GiftOptionalID", "int", { is_primary_key: true, is_nullable: false }),
    col("Idx", "int", { is_primary_key: true, is_nullable: false }),
    col("Note", "varchar(64)", { is_nullable: false }),
  ]);
  meta.primaryKeys = ["GiftOptionalID"];

  const sameFirstKey = validateRowDraft({
    table: meta,
    rows: [{ GiftOptionalID: "1", Idx: "1", Note: "gift-1" }],
    draft: { GiftOptionalID: "1", Idx: "2", Note: "gift-2" },
  });
  assert.equal(sameFirstKey.valid, true);

  const sameCompositeKey = validateRowDraft({
    table: meta,
    rows: [{ GiftOptionalID: "1", Idx: "1", Note: "gift-1" }],
    draft: { GiftOptionalID: "1", Idx: "1", Note: "copy" },
  });
  assert.equal(sameCompositeKey.valid, false);
  assert.equal(sameCompositeKey.errors[0].code, "duplicate-primary-key");
  assert.deepEqual(sameCompositeKey.errors[0].columns, ["GiftOptionalID", "Idx"]);
});

test("validateRowDraft allows omitted auto increment and defaulted required fields", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false, is_auto_increment: true }),
    col("created_at", "datetime", { is_nullable: false, default_mode: "expression" }),
    col("name", "varchar(8)", { is_nullable: false }),
  ]);

  const result = validateRowDraft({ table: meta, rows: [], draft: { name: "alice" } });

  assert.equal(result.valid, true);
});

test("validateRowDraft accepts explicit empty strings for non-null string columns", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false }),
    col("title", "varchar(255)", { is_nullable: false }),
  ]);

  const result = validateRowDraft({ table: meta, rows: [], draft: { id: "1", title: "" } });

  assert.equal(result.valid, true);
});

test("validateRowDraft rejects explicit empty string primary keys", () => {
  const meta = table([
    col("code", "varchar(16)", { is_primary_key: true, is_nullable: false }),
    col("title", "varchar(255)", { is_nullable: false }),
  ]);

  const result = validateRowDraft({ table: meta, rows: [], draft: { code: "", title: "" } });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "required");
});

test("validateRowDraft treats MySQL extra auto_increment as an omitted backend default", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false, extra: "auto_increment" }),
    col("name", "varchar(8)", { is_nullable: false }),
  ]);

  const result = validateRowDraft({ table: meta, rows: [], draft: { name: "alice" } });

  assert.equal(result.valid, true);
});

test("validateRowDraft rejects explicit empty values even when defaults exist", () => {
  const meta = table([
    col("id", "int", { is_primary_key: true, is_nullable: false, is_auto_increment: true }),
    col("name", "varchar(8)", { is_nullable: false }),
  ]);

  const result = validateRowDraft({ table: meta, rows: [], draft: { id: "", name: "alice" } });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "required");
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

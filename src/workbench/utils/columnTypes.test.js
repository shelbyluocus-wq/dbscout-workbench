import test from "node:test";
import assert from "node:assert/strict";

import { isNumericColumnType } from "./columnTypes.js";

test("isNumericColumnType matches MySQL numeric families", () => {
  for (const type of ["int", "int(11)", "bigint(20) unsigned", "tinyint(1)", "decimal(10,2)", "float", "double", "year", "bit(8)"]) {
    assert.equal(isNumericColumnType(type), true, type);
  }
});

test("isNumericColumnType matches ClickHouse numeric families", () => {
  for (const type of ["Int32", "UInt64", "Float64", "Decimal(10,2)"]) {
    assert.equal(isNumericColumnType(type), true, type);
  }
});

test("isNumericColumnType rejects text/date/other families", () => {
  for (const type of ["varchar(32)", "char(1)", "text", "longtext", "datetime", "timestamp", "date", "json", "enum('a','b')", "interval", ""]) {
    assert.equal(isNumericColumnType(type), false, type);
  }
  assert.equal(isNumericColumnType(null), false);
  assert.equal(isNumericColumnType(undefined), false);
});

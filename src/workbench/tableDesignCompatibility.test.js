import test from "node:test";
import assert from "node:assert/strict";

import { validateTableDesignConversion } from "./utils/tableDesignCompatibility.js";

function column(columnType, nullable = true) {
  return {
    column_name: "value",
    column_type: columnType,
    data_type: columnType.split(/[\s(]/)[0],
    is_nullable: nullable,
    is_primary_key: false,
  };
}

test("DDL compatibility treats tinyint(1) as display width, not boolean", () => {
  assert.equal(validateTableDesignConversion(column("tinyint(1)"), "2").valid, true);
  assert.equal(validateTableDesignConversion(column("tinyint(1)"), "128").valid, false);
  assert.equal(validateTableDesignConversion(column("tinyint(1)"), "true").valid, false);
});

test("DDL compatibility validates bit width and text/blob byte limits", () => {
  assert.equal(validateTableDesignConversion(column("bit(2)"), "3").valid, true);
  assert.equal(validateTableDesignConversion(column("bit(2)"), "4").valid, false);
  assert.equal(validateTableDesignConversion(column("tinytext"), "x".repeat(255)).valid, true);
  assert.equal(validateTableDesignConversion(column("tinytext"), "x".repeat(256)).valid, false);
  assert.equal(validateTableDesignConversion(column("varbinary(1)"), "猫").valid, false);
});

test("DDL compatibility keeps significant string whitespace", () => {
  assert.equal(validateTableDesignConversion(column("varchar(1)"), " ").valid, true);
  assert.equal(validateTableDesignConversion(column("varchar(1)"), "  ").valid, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { formatTableTabTitle } from "./tabDisplay.js";

test("table tab title includes its database", () => {
  assert.equal(
    formatTableTabTitle(
      { database: "edota_3cfg", tableName: "mountprop" },
      "edota_3cfg",
    ),
    "mountprop @edota_3cfg",
  );
});

test("table tab title uses the database display name and handles legacy tabs", () => {
  assert.equal(
    formatTableTabTitle({ database: "edota_3cfg", tableName: "mountprop" }, "正式服配置"),
    "mountprop @正式服配置",
  );
  assert.equal(formatTableTabTitle({ tableName: "mountprop" }), "mountprop");
});

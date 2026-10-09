import test from "node:test";
import assert from "node:assert/strict";
import { resolveInspectorCommentTarget } from "./inspectorCommentTarget.js";

function node({ schemaColumn = "", tableStatus = false, parent = null } = {}) {
  return {
    getAttribute(name) {
      return name === "data-schema-column" ? schemaColumn : null;
    },
    closest(selector) {
      if (selector === "[data-schema-column]" && schemaColumn) return this;
      if (selector === ".wb-inspector-table-status" && tableStatus) return this;
      return parent?.closest(selector) || null;
    },
  };
}

const columns = [
  { column_name: "HeroFmt", column_comment: "英雄布阵" },
  { columnName: "PetFmtN", columnComment: "战宠阵容" },
];

test("right-clicking a field edits that field comment", () => {
  const target = resolveInspectorCommentTarget(
    { target: node({ schemaColumn: "HeroFmt" }) },
    { columns, selectedColumn: "PetFmtN", tableComment: "养成表" },
  );
  assert.deepEqual(target, { kind: "column", columnName: "HeroFmt", comment: "英雄布阵" });
});

test("right-clicking the table summary edits the table comment", () => {
  const target = resolveInspectorCommentTarget(
    { target: node({ tableStatus: true }) },
    { columns, selectedColumn: "HeroFmt", tableComment: "养成表" },
  );
  assert.deepEqual(target, { kind: "table", columnName: "", comment: "养成表" });
});

test("right-clicking empty remarks space edits the selected field", () => {
  const target = resolveInspectorCommentTarget(
    { target: node() },
    { columns, selectedColumn: "PetFmtN", tableComment: "养成表" },
  );
  assert.deepEqual(target, { kind: "column", columnName: "PetFmtN", comment: "战宠阵容" });
});

test("right-clicking empty remarks space without a selected field edits the table comment", () => {
  const target = resolveInspectorCommentTarget(
    { target: node() },
    { columns, tableComment: "养成表" },
  );
  assert.deepEqual(target, { kind: "table", columnName: "", comment: "养成表" });
});

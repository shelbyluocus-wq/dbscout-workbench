import test from "node:test";
import assert from "node:assert/strict";

import { auditRowSummary, auditRowSummaryLabel } from "./auditDisplay.js";

test("新增日志显示新增后的整行内容", () => {
  assert.equal(
    auditRowSummary({ operation: "INSERT", newValue: JSON.stringify({ id: "7", name: "Alice", note: null }) }),
    "id=7，name=Alice，note=NULL",
  );
  assert.equal(auditRowSummaryLabel("INSERT"), "新增内容");
});

test("删除日志显示删除前的整行内容", () => {
  assert.equal(
    auditRowSummary({ operation: "DELETE", oldValue: JSON.stringify({ id: "8", name: "Bob" }) }),
    "id=8，name=Bob",
  );
  assert.equal(auditRowSummaryLabel("DELETE"), "删除内容");
});

test("普通改单元格日志不生成整行摘要", () => {
  assert.equal(auditRowSummary({ operation: "UPDATE", oldValue: "1", newValue: "2" }), "");
});

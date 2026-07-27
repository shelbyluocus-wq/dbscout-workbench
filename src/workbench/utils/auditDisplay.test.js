import test from "node:test";
import assert from "node:assert/strict";

import {
  auditChangeItems,
  auditChangeSql,
  auditChangeSummary,
  auditHasDetails,
  auditRowSummary,
  auditRowSummaryLabel,
} from "./auditDisplay.js";

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

test("单元格和批量修改生成明确的字段级摘要", () => {
  assert.equal(
    auditChangeSummary({ operation: "UPDATE", columnName: "isNpc", oldValue: "0", newValue: "1" }),
    "isNpc：0 → 1",
  );
  assert.deepEqual(
    auditChangeItems({
      operation: "UPDATE",
      oldValue: JSON.stringify({ level: "12", status: "active" }),
      newValue: JSON.stringify({ level: "13", status: "active", note: null }),
    }),
    ["level：12 → 13", "note：未设置 → NULL"],
  );
  assert.equal(
    auditHasDetails({
      operation: "UPDATE",
      columnName: "description",
      oldValue: "旧说明",
      newValue: "这是一段在紧凑日志行中无法完整放下、需要通过详细信息入口查看的较长说明文本",
    }),
    true,
  );
});

test("结构日志优先显示设计器保存的人类可读说明", () => {
  const entry = {
    operation: "DDL",
    newValue: JSON.stringify([
      "🔧 修改字段「name」：类型 VARCHAR(32) → VARCHAR(64)",
      "➕ 新增字段「remark」：类型 TEXT；允许 NULL",
    ]),
    forwardSql: "ALTER TABLE `player` MODIFY COLUMN `name` varchar(64), ADD COLUMN `remark` text",
    notes: "结构变更，需通过快照还原",
  };

  assert.deepEqual(auditChangeItems(entry), [
    "修改字段「name」：类型 VARCHAR(32) → VARCHAR(64)",
    "新增字段「remark」：类型 TEXT；允许 NULL",
  ]);
  assert.match(auditChangeSummary(entry, 48), /修改字段「name」/);
  assert.equal(auditChangeSql(entry), entry.forwardSql);
  assert.equal(auditHasDetails(entry, 48), true);
});

test("历史结构日志可从原始 SQL 恢复可读摘要", () => {
  const entry = {
    operation: "DDL",
    forwardSql: [
      "ALTER TABLE `player` DROP COLUMN `legacy`",
      "ALTER TABLE `player` CHANGE COLUMN `name` `display_name` varchar(64)",
      "ALTER TABLE `player` ADD COLUMN `remark` text NULL",
      "ALTER TABLE `player` DROP PRIMARY KEY",
      "ALTER TABLE `player` ADD PRIMARY KEY (`id`)",
    ].join(";\n"),
  };

  assert.deepEqual(auditChangeItems(entry), [
    "新增字段「remark」",
    "删除字段「legacy」",
    "字段重命名「name」→「display_name」",
    "取消主键",
    "新增主键",
  ]);
});

import test from "node:test";
import assert from "node:assert/strict";

import en from "../i18n/en.js";
import zhCN from "../i18n/zhCN.js";
import zhTW from "../i18n/zhTW.js";
import {
  STATUS_MESSAGE_RULES,
  describeStatusMessage,
  localizeStatusMessage,
  statusMessageCatalogKeys,
} from "./statusMessages.js";

test("every status rule key exists in all three catalogs", () => {
  for (const key of statusMessageCatalogKeys()) {
    assert.ok(Object.hasOwn(en, key), `en: ${key}`);
    assert.ok(Object.hasOwn(zhCN, key), `zh-CN: ${key}`);
    assert.ok(Object.hasOwn(zhTW, key), `zh-TW: ${key}`);
  }
});

test("Simplified Chinese catalog entries reproduce the source templates they map", () => {
  for (const rule of STATUS_MESSAGE_RULES) {
    if (!rule.key || rule.compose || rule.pick) continue;
    // Digits satisfy both numeric and free-text placeholders.
    const params = Object.fromEntries(rule.names.map((name, index) => [name, String(index + 2)]));
    const sample = zhCN[rule.key].replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => params[name] ?? "");
    const tone = describeStatusMessage(sample)?.tone ?? null;
    assert.notEqual(tone, null, `${rule.key} should classify its own template: ${sample}`);
  }
});

test("failures, blocked actions and completions get the right tone", () => {
  assert.equal(describeStatusMessage("提交事务失败：Deadlock found").tone, "error");
  assert.equal(describeStatusMessage("只读连接不能删除数据").tone, "warning");
  assert.equal(describeStatusMessage("剪贴板为空，未修改数据").tone, "warning");
  assert.equal(describeStatusMessage("无可撤销操作").tone, "info");
  assert.equal(describeStatusMessage("已导出 120 行 → D:\\out\\hero.xlsx").tone, "success");
  assert.equal(describeStatusMessage("批量导入完成：新增 1，更新 2，删除 0，未变化 3，0 个错误").tone, "success");
  assert.equal(describeStatusMessage("批量导入完成：新增 1，更新 2，删除 0，未变化 3，4 个错误").tone, "warning");
  assert.equal(describeStatusMessage("正在粘贴表，请勿重复操作").tone, "warning");
});

test("progress chatter and locally shown results stay quiet", () => {
  for (const message of [
    "已打开表：hero",
    "加载 game_db.hero",
    "正在删除 3 行，请稍候…",
    "已刷新 hero",
    "已连接数据库：game_db",
    "已复制 3×2 区域",
    "已保存 hero.name",
    "读取表失败：timeout",
    "",
  ]) {
    assert.equal(describeStatusMessage(message), null, message);
  }
  assert.equal(describeStatusMessage("读取表失败：timeout", { explicitError: true }), null);
});

test("unknown messages fall back to keyword heuristics and the explicit error flag", () => {
  assert.equal(describeStatusMessage("同步异常：连接中断").tone, "error");
  assert.equal(describeStatusMessage("无法完成这个动作").tone, "warning");
  assert.equal(describeStatusMessage("一切正常"), null);
  assert.equal(describeStatusMessage("一切正常", { explicitError: true }).tone, "error");
});

test("messages render in the interface language", () => {
  assert.deepEqual(localizeStatusMessage("提交事务失败：Deadlock found", "zh-CN"), { title: "提交事务失败：Deadlock found", detail: "" });
  assert.equal(localizeStatusMessage("提交事务失败：Deadlock found", "en").title, "Couldn't commit the transaction: Deadlock found");
  assert.equal(localizeStatusMessage("提交事务失败：Deadlock found", "zh-TW").title, "提交交易失敗：Deadlock found");
  assert.equal(localizeStatusMessage("只读连接不能删除数据", "en").title, "This connection is read-only, so you can't delete data");
  assert.equal(localizeStatusMessage("无法粘贴：目标范围超出可编辑列", "zh-TW").title, "無法貼上：目標範圍超出可編輯欄位");
  assert.equal(localizeStatusMessage("已删除 1 行", "en").title, "Deleted 1 row");
  assert.equal(localizeStatusMessage("已删除 4 行", "en").title, "Deleted 4 rows");
  assert.equal(localizeStatusMessage("已撤销：新增 3 行", "en").title, "Undid adding 3 rows");
  assert.equal(
    localizeStatusMessage("导入完成：新增 3，覆盖 1，删除 0，未变化 9，跳过 2；原表已备份至 C:\\bak.sql", "en").title,
    "Import complete: 3 added, 1 overwritten, 0 deleted, 9 unchanged. 2 skipped. The original table was backed up to C:\\bak.sql",
  );
});

test("messages without a translation keep their text with a localized English heading", () => {
  assert.deepEqual(localizeStatusMessage("某个未知的失败消息", "en"), { title: "Something went wrong", detail: "某个未知的失败消息" });
  assert.deepEqual(localizeStatusMessage("某个未知的失败消息", "zh-TW"), { title: "某个未知的失败消息", detail: "" });
  assert.match(localizeStatusMessage("同步完成", "en", { tone: "success" }).title, /^Done$/);
});

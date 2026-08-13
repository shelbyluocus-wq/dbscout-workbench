import test from "node:test";
import assert from "node:assert/strict";

import { useConfirm } from "./composables/useConfirm.js";

test("alert dialogs hide the cancel action", async () => {
  const { alert, close, confirmDialog } = useConfirm();
  const alertPromise = alert({ title: "保存成功", message: "备份设置已保存。" });

  assert.equal(confirmDialog.open, true);
  assert.equal(confirmDialog.cancelText, null);

  close(true);
  await alertPromise;
  assert.equal(confirmDialog.open, false);
});

test("confirm dialogs keep the default cancel action", async () => {
  const { close, confirm, confirmDialog } = useConfirm();
  const confirmPromise = confirm({ title: "清理旧快照？", message: "确认清理旧快照。" });

  assert.equal(confirmDialog.open, true);
  assert.notEqual(confirmDialog.cancelText, null);

  close(false);
  assert.equal(await confirmPromise, false);
  assert.equal(confirmDialog.open, false);
});

test("confirm dialogs expose structured items and reset them for the next request", async () => {
  const { close, confirm, confirmDialog } = useConfirm();
  const structuredPromise = confirm({
    title: "删除 2 张表",
    message: "即将从 game_db 删除以下表",
    items: ["orders", "players"],
    note: "此操作不可撤销。",
  });

  assert.deepEqual(confirmDialog.items, ["orders", "players"]);
  assert.equal(confirmDialog.note, "此操作不可撤销。");
  close(false);
  await structuredPromise;

  const plainPromise = confirm({ title: "普通确认", message: "继续吗？" });
  assert.deepEqual(confirmDialog.items, []);
  assert.equal(confirmDialog.note, "");
  close(false);
  await plainPromise;
});

test("confirm dialogs can expose a distinct third action", async () => {
  const { close, confirm, confirmDialog } = useConfirm();
  const confirmPromise = confirm({
    title: "新增行尚未保存",
    message: "关闭前请选择如何处理。",
    confirmText: "保存并关闭",
    alternativeText: "放弃并关闭",
    alternativeDanger: true,
  });

  assert.equal(confirmDialog.alternativeText, "放弃并关闭");
  assert.equal(confirmDialog.alternativeDanger, true);
  close("alternative");
  assert.equal(await confirmPromise, "alternative");

  const nextPromise = confirm({ title: "普通确认" });
  assert.equal(confirmDialog.alternativeText, null);
  assert.equal(confirmDialog.alternativeDanger, false);
  close(false);
  await nextPromise;
});

test("concurrent confirmation requests are shown and resolved in FIFO order", async () => {
  const { close, confirm, confirmDialog } = useConfirm();
  const first = confirm({ title: "第一个确认", message: "先处理我" });
  const second = confirm({ title: "第二个确认", message: "随后处理我" });

  assert.equal(confirmDialog.title, "第一个确认");
  close(true);
  assert.equal(await first, true);
  await Promise.resolve();

  assert.equal(confirmDialog.open, true);
  assert.equal(confirmDialog.title, "第二个确认");
  close(false);
  assert.equal(await second, false);
  assert.equal(confirmDialog.open, false);
});

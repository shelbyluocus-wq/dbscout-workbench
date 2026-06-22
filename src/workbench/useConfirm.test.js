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

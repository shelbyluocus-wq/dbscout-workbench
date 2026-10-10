import test from "node:test";
import assert from "node:assert/strict";

import {
  NOTICE_COALESCE_MS,
  NOTICE_DURATION_MS,
  NOTICE_SUPPRESS_MS,
  createOperationNotices,
} from "./operationNotices.js";

function fakeClock() {
  let time = 1_000;
  let nextHandle = 1;
  const pending = new Map();
  return {
    now: () => time,
    schedule(callback, ms) {
      const handle = nextHandle++;
      pending.set(handle, { callback, at: time + ms });
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    advance(ms) {
      time += ms;
      for (const [handle, entry] of [...pending]) {
        if (entry.at <= time) {
          pending.delete(handle);
          entry.callback();
        }
      }
    },
  };
}

function texts(notices) {
  return notices.state.items.map((item) => item.text);
}

test("notices auto-dismiss by tone and errors stay longest", () => {
  const clock = fakeClock();
  const notices = createOperationNotices(clock);
  notices.push({ tone: "success", text: "已导出 3 行" });
  notices.push({ tone: "error", text: "提交事务失败：x" });

  clock.advance(NOTICE_DURATION_MS.success);
  assert.deepEqual(texts(notices), ["提交事务失败：x"]);
  clock.advance(NOTICE_DURATION_MS.error - NOTICE_DURATION_MS.success);
  assert.deepEqual(texts(notices), []);
});

test("hovering pauses the timer and leaving restarts it", () => {
  const clock = fakeClock();
  const notices = createOperationNotices(clock);
  const id = notices.push({ tone: "warning", text: "剪贴板为空，未修改数据" });

  notices.pause(id);
  clock.advance(NOTICE_DURATION_MS.warning * 3);
  assert.equal(notices.state.items.length, 1);

  notices.resume(id);
  clock.advance(NOTICE_DURATION_MS.warning - 1);
  assert.equal(notices.state.items.length, 1);
  clock.advance(1);
  assert.equal(notices.state.items.length, 0);
});

test("the same event delivered twice merges, while a later repeat is counted", () => {
  const clock = fakeClock();
  const notices = createOperationNotices(clock);
  notices.push({ tone: "success", text: "已复制 2 张表" });
  clock.advance(NOTICE_COALESCE_MS - 1);
  notices.push({ tone: "success", text: "已复制 2 张表" });
  assert.equal(notices.state.items.length, 1);
  assert.equal(notices.state.items[0].count, 1);

  clock.advance(NOTICE_COALESCE_MS + 1);
  notices.push({ tone: "success", text: "已复制 2 张表" });
  assert.equal(notices.state.items.length, 1);
  assert.equal(notices.state.items[0].count, 2);
});

test("a short feedback title absorbs the detailed status text written with it", () => {
  const clock = fakeClock();
  const notices = createOperationNotices(clock);
  notices.push({ tone: "success", text: "导出成功", detail: "已导出 12 行 → D:\\out.xlsx" });
  clock.advance(5_000 - NOTICE_DURATION_MS.success + 10);
  notices.push({ tone: "success", text: "已导出 12 行 → D:\\out.xlsx" });

  assert.equal(notices.state.items.length, 1);
  assert.equal(notices.state.items[0].text, "导出成功");
  assert.equal(notices.state.items[0].detail, "已导出 12 行 → D:\\out.xlsx");
  assert.equal(notices.state.items[0].count, 1);
});

test("a short title arriving after its detailed status text takes over the title", () => {
  const clock = fakeClock();
  const notices = createOperationNotices(clock);
  notices.push({ tone: "success", text: "批量导出完成：3 张表，100 行" });
  clock.advance(10);
  notices.push({ tone: "warning", text: "批量导出完成，1 张表失败", detail: "批量导出完成：3 张表，100 行" });

  assert.equal(notices.state.items.length, 1);
  assert.deepEqual(
    { text: notices.state.items[0].text, detail: notices.state.items[0].detail, tone: notices.state.items[0].tone },
    { text: "批量导出完成，1 张表失败", detail: "批量导出完成：3 张表，100 行", tone: "warning" },
  );
});

test("a merged notice escalates to the more severe tone", () => {
  const notices = createOperationNotices(fakeClock());
  notices.push({ tone: "success", text: "批量导出成功" });
  notices.push({ tone: "warning", text: "批量导出成功" });
  assert.equal(notices.state.items[0].tone, "warning");
});

test("the stack keeps only the newest notices", () => {
  const notices = createOperationNotices({ ...fakeClock(), limit: 3 });
  ["a", "b", "c", "d"].forEach((text) => notices.push({ tone: "info", text }));
  assert.deepEqual(texts(notices), ["b", "c", "d"]);
});

test("messages already shown beside a cell are not repeated", () => {
  const clock = fakeClock();
  const notices = createOperationNotices(clock);
  notices.suppress("保存失败：Duplicate entry");
  assert.equal(notices.push({ tone: "error", text: "保存失败：Duplicate entry" }), null);
  assert.equal(notices.state.items.length, 0);

  clock.advance(NOTICE_SUPPRESS_MS + 1);
  assert.notEqual(notices.push({ tone: "error", text: "保存失败：Duplicate entry" }), null);
});

test("blank text, unknown tones and manual dismissal are handled", () => {
  const notices = createOperationNotices(fakeClock());
  assert.equal(notices.push({ tone: "error", text: "   " }), null);
  const id = notices.push({ tone: "bogus", text: "提示" });
  assert.equal(notices.state.items[0].tone, "info");
  notices.dismiss(id);
  assert.equal(notices.state.items.length, 0);
  notices.push({ tone: "info", text: "x" });
  notices.clear();
  assert.equal(notices.state.items.length, 0);
});

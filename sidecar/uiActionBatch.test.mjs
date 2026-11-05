import assert from "node:assert/strict";
import { test } from "node:test";
import { runUiActionBatch } from "./uiActionBatch.mjs";

const fakeControl = (failAt = -1) => ({
  calls: [],
  async request(op, payload) {
    this.calls.push(payload);
    if (this.calls.length - 1 === failAt) throw new Error("步骤失败");
    return { done: payload.action };
  },
});

test("batch runs steps in order and stops at the first failure", async () => {
  const control = fakeControl(1);
  const out = await runUiActionBatch(control, [
    { action: "open_table", args: { table: "a" } },
    { action: "focus_cell", args: { table: "a" } },
    { action: "refresh_table", args: { table: "a" } },
  ]);
  assert.equal(control.calls.length, 2);
  assert.equal(out.completed, 1);
  assert.equal(out.stoppedAt, "focus_cell");
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
});

test("batch rejects unknown actions and bad step counts before sending", async () => {
  const control = fakeControl();
  await assert.rejects(() => runUiActionBatch(control, [{ action: "drop_everything" }]), /不支持/);
  await assert.rejects(() => runUiActionBatch(control, []), /1-20/);
  assert.equal(control.calls.length, 0);
});

test("compact batch returns context once, timing, and full mode preserves responses", async () => {
  const context = { tableName: "items", columns: ["id", "name"] };
  const control = { async request() { return { message: "done", context }; } };
  const steps = [{ action: "open_table" }, { action: "scroll_table", args: { direction: "down" } }];
  const compact = await runUiActionBatch(control, steps);
  assert.deepEqual(compact.context, context);
  assert.equal(compact.results[0].data, undefined);
  assert.equal(compact.results[0].message, "done");
  assert.ok(compact.durationMs >= 0);
  assert.ok(compact.results.every((step) => step.durationMs >= 0));
  const full = await runUiActionBatch(control, steps, { detail: "full" });
  assert.deepEqual(full.results[0].data.context, context);
});

test("demo labels steps and waits only between successful actions", async () => {
  const control = fakeControl();
  const result = await runUiActionBatch(control, [{ action: "open_table" }, { action: "focus_column" }], { mode: "demo", pauseMs: 100 });
  assert.deepEqual(control.calls.map((call) => call.args.demoStep), ["1/2", "2/2"]);
  assert.ok(result.durationMs >= 90);
  await assert.rejects(() => runUiActionBatch(control, [{ action: "open_table" }], { pauseMs: 0 }), /无效/);
  const failed = await runUiActionBatch(fakeControl(0), [{ action: "open_table" }]);
  assert.equal(failed.stoppedIndex, 0);
});

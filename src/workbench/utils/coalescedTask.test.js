import test from "node:test";
import assert from "node:assert/strict";
import { createCoalescedTask } from "./coalescedTask.js";

function fakeClock() {
  let time = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("a burst of schedules runs once after the quiet delay", () => {
  const clock = fakeClock();
  let runs = 0;
  const task = createCoalescedTask(() => { runs += 1; }, { delayMs: 400, maxWaitMs: 2000, ...clock });
  for (let index = 0; index < 5; index += 1) {
    task.schedule();
    clock.advance(100);
  }
  assert.equal(runs, 0);
  clock.advance(400);
  assert.equal(runs, 1);
  assert.equal(task.isPending(), false);
});

test("continuous scheduling still runs by the max wait", () => {
  const clock = fakeClock();
  let runs = 0;
  const task = createCoalescedTask(() => { runs += 1; }, { delayMs: 400, maxWaitMs: 1000, ...clock });
  for (let index = 0; index < 12; index += 1) {
    task.schedule();
    clock.advance(100);
  }
  assert.ok(runs >= 1);
});

test("flush runs pending work immediately and is a no-op when idle", () => {
  const clock = fakeClock();
  let runs = 0;
  const task = createCoalescedTask(() => { runs += 1; }, clock);
  assert.equal(task.flush(), false);
  task.schedule();
  assert.equal(task.flush(), true);
  assert.equal(runs, 1);
  clock.advance(5000);
  assert.equal(runs, 1);
  assert.equal(task.flush({ force: true }), true);
  assert.equal(runs, 2);
});

test("cancel drops pending work", () => {
  const clock = fakeClock();
  let runs = 0;
  const task = createCoalescedTask(() => { runs += 1; }, clock);
  task.schedule();
  task.cancel();
  clock.advance(5000);
  assert.equal(runs, 0);
});

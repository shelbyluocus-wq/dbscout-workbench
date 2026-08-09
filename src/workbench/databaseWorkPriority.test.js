import test from "node:test";
import assert from "node:assert/strict";

import { createDatabaseWorkPriority } from "./composables/databaseWorkPriority.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const source = { connectionId: "mysql-main", database: "app" };

test("foreground table work holds queued background work until it finishes", async () => {
  const priority = createDatabaseWorkPriority();
  const releaseForeground = priority.beginForeground(source);
  let started = false;

  const background = priority.runBackground(source, async () => {
    started = true;
    return "done";
  });
  await Promise.resolve();

  assert.equal(started, false);
  releaseForeground();
  assert.equal(await background, "done");
  assert.equal(started, true);
});

test("running background work stays capped while new foreground work starts immediately", async () => {
  const priority = createDatabaseWorkPriority({ maxBackgroundPerSource: 2 });
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started = [];

  const tasks = [first, second, third].map((pending, index) => (
    priority.runBackground(source, () => {
      started.push(index + 1);
      return pending.promise;
    })
  ));
  await Promise.resolve();

  assert.deepEqual(started, [1, 2]);
  const releaseForeground = priority.beginForeground(source);
  first.resolve();
  await tasks[0];
  await Promise.resolve();
  assert.deepEqual(started, [1, 2], "queued background work must keep yielding to foreground work");

  releaseForeground();
  for (let turn = 0; turn < 10 && started.length < 3; turn += 1) await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);

  second.resolve();
  third.resolve();
  await Promise.all(tasks);
});

test("different databases keep independent background lanes", async () => {
  const priority = createDatabaseWorkPriority({ maxBackgroundPerSource: 1 });
  const releaseForeground = priority.beginForeground(source);
  const started = [];

  const blocked = priority.runBackground(source, () => started.push("app"));
  const other = priority.runBackground(
    { connectionId: "mysql-main", database: "analytics" },
    () => started.push("analytics"),
  );
  await other;

  assert.deepEqual(started, ["analytics"]);
  releaseForeground();
  await blocked;
  assert.deepEqual(started, ["analytics", "app"]);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  createHomeTablePasteCoordinator,
  isSameDatabaseSource,
} from "./homeTablePasteCoordinator.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

test("database source matching requires the same non-empty connection and database", () => {
  assert.equal(
    isSameDatabaseSource(
      { connectionId: "mysql-main", database: "source" },
      { connectionId: "mysql-main", database: "source" },
    ),
    true,
  );
  assert.equal(
    isSameDatabaseSource(
      { connectionId: "mysql-main", database: "source" },
      { connectionId: "mysql-main", database: "target" },
    ),
    false,
  );
  assert.equal(isSameDatabaseSource({ connectionId: "", database: "source" }, {}), false);
});

test("paste waits for the matching database navigation before running", async () => {
  const navigation = deferred();
  const waits = [];
  const calls = [];
  let committedSource = { connectionId: "mysql-main", database: "source" };
  const coordinator = createHomeTablePasteCoordinator({
    getCommittedSource: () => committedSource,
    onWaitForNavigation: (target) => waits.push(target),
  });
  coordinator.trackNavigation(
    { connectionId: "mysql-main", database: "target" },
    navigation.promise,
  );

  const paste = coordinator.runWhenReady(
    { connectionId: "mysql-main", database: "target" },
    async (target) => {
      calls.push(target);
      return "copied";
    },
  );
  await flushAsync();

  assert.deepEqual(waits, [{ connectionId: "mysql-main", database: "target" }]);
  assert.deepEqual(calls, []);
  assert.equal(coordinator.isPasting(), true);

  committedSource = { connectionId: "mysql-main", database: "target" };
  navigation.resolve(true);

  assert.deepEqual(await paste, { ok: true, value: "copied" });
  assert.deepEqual(calls, [{ connectionId: "mysql-main", database: "target" }]);
  assert.equal(coordinator.isPasting(), false);
});

test("paste never runs when navigation fails or the committed target does not match", async () => {
  const navigation = deferred();
  let actionCalls = 0;
  const coordinator = createHomeTablePasteCoordinator({
    getCommittedSource: () => ({ connectionId: "mysql-main", database: "source" }),
  });
  coordinator.trackNavigation(
    { connectionId: "mysql-main", database: "target" },
    navigation.promise,
  );
  const paste = coordinator.runWhenReady(
    { connectionId: "mysql-main", database: "target" },
    async () => { actionCalls += 1; },
  );
  navigation.resolve(false);

  assert.deepEqual(await paste, { ok: false, reason: "navigation-failed" });
  assert.equal(actionCalls, 0);

  assert.deepEqual(
    await coordinator.runWhenReady(
      { connectionId: "mysql-main", database: "target" },
      async () => { actionCalls += 1; },
    ),
    { ok: false, reason: "target-not-ready" },
  );
  assert.equal(actionCalls, 0);
});

test("a repeated paste is rejected while the first paste is still running", async () => {
  const action = deferred();
  let actionCalls = 0;
  const target = { connectionId: "mysql-main", database: "target" };
  const coordinator = createHomeTablePasteCoordinator({
    getCommittedSource: () => target,
  });

  const firstPaste = coordinator.runWhenReady(target, async () => {
    actionCalls += 1;
    return action.promise;
  });
  await flushAsync();

  assert.deepEqual(
    await coordinator.runWhenReady(target, async () => { actionCalls += 1; }),
    { ok: false, reason: "paste-pending" },
  );
  assert.equal(actionCalls, 1);

  action.resolve("done");
  assert.deepEqual(await firstPaste, { ok: true, value: "done" });
  assert.equal(coordinator.isPasting(), false);
});

test("a rejected database navigation releases the paste lock for a later retry", async () => {
  const navigation = deferred();
  const target = { connectionId: "mysql-main", database: "target" };
  let committedSource = { connectionId: "mysql-main", database: "source" };
  let actionCalls = 0;
  const coordinator = createHomeTablePasteCoordinator({
    getCommittedSource: () => committedSource,
  });
  coordinator.trackNavigation(target, navigation.promise);
  const firstPaste = coordinator.runWhenReady(target, async () => { actionCalls += 1; });

  navigation.reject(new Error("database offline"));
  await assert.rejects(firstPaste, /database offline/);
  assert.equal(actionCalls, 0);
  assert.equal(coordinator.isPasting(), false);

  committedSource = target;
  assert.deepEqual(
    await coordinator.runWhenReady(target, async () => { actionCalls += 1; return "retried"; }),
    { ok: true, value: "retried" },
  );
  assert.equal(actionCalls, 1);
});

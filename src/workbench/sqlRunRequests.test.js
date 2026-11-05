import assert from "node:assert/strict";
import { test } from "node:test";
import { requestSqlRun, resolveSqlRun } from "./utils/sqlRunRequests.js";

test("resolveSqlRun resolves with status and rowCount", async () => {
  const tab = {};
  const promise = requestSqlRun(tab, {});
  assert.equal(typeof tab.agentRunRequest?.id, "string");
  const id = tab.agentRunRequest.id;
  assert.equal(resolveSqlRun(id, { status: "ok", rowCount: 12 }), true);
  assert.deepEqual(await promise, { status: "ok", rowCount: 12, error: "" });
});

test("timeout rejects when nothing resolves", async () => {
  const tab = {};
  const promise = requestSqlRun(tab, { timeoutMs: 15 });
  await assert.rejects(promise, /超时/);
});

test("resolving an unknown id returns false", () => {
  assert.equal(resolveSqlRun("nope", {}), false);
});

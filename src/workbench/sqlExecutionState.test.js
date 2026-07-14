import test from "node:test";
import assert from "node:assert/strict";

import { applySqlExecutionEvent, resetSqlExecution } from "./sqlExecutionState.js";

test("SQL execution state collects multiple result sets and truncation", () => {
  const tab = { kind: "sql", resultSets: [], messages: [] };
  resetSqlExecution(tab, "exec-1");
  applySqlExecutionEvent(tab, { type: "statement-started", executionId: "exec-1", statementIndex: 0, sql: "SELECT 1" });
  applySqlExecutionEvent(tab, { type: "result-meta", executionId: "exec-1", statementIndex: 0, columns: [{ name: "value" }] });
  applySqlExecutionEvent(tab, { type: "row-batch", executionId: "exec-1", statementIndex: 0, rows: [{ value: 1 }] });
  applySqlExecutionEvent(tab, { type: "statement-completed", executionId: "exec-1", statementIndex: 0, rowCount: 1, truncated: true });
  applySqlExecutionEvent(tab, { type: "statement-started", executionId: "exec-1", statementIndex: 1, sql: "SELECT 2" });
  assert.equal(tab.resultSets.length, 2);
  assert.equal(tab.resultSets[0].rows[0].value, 1);
  assert.equal(tab.resultSets[0].truncated, true);
});

test("stale SQL execution events are ignored", () => {
  const tab = { kind: "sql", executionId: "new", resultSets: [], messages: [] };
  assert.equal(applySqlExecutionEvent(tab, { type: "statement-started", executionId: "old" }), false);
  assert.equal(tab.resultSets.length, 0);
});

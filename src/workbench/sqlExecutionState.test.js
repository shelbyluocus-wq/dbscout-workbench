import test from "node:test";
import assert from "node:assert/strict";

import {
  applySqlExecutionEvent,
  resetSqlExecution,
  sqlResultPane,
  sqlResultStatusText,
} from "./sqlExecutionState.js";

function sqlTab() {
  return { kind: "sql", resultSets: [], messages: [] };
}

function runEvents(tab, executionId, events) {
  resetSqlExecution(tab, executionId);
  for (const event of events) applySqlExecutionEvent(tab, { executionId, ...event });
}

test("SQL execution state collects multiple result sets and truncation", () => {
  const tab = sqlTab();
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

test("write-only SQL execution switches to messages and keeps a readable results summary", () => {
  const tab = sqlTab();
  runEvents(tab, "exec-ddl", [
    { type: "statement-started", statementIndex: 0, sql: "ALTER TABLE t ADD COLUMN x int", category: "write" },
    { type: "statement-completed", statementIndex: 0, durationMs: 271, rowCount: 0, affectedRows: 0, message: "影响 0 行" },
    { type: "statement-started", statementIndex: 1, sql: "ALTER TABLE u ADD COLUMN x int", category: "write" },
    { type: "statement-completed", statementIndex: 1, durationMs: 143, rowCount: 0, affectedRows: 0, message: "影响 0 行" },
    { type: "execution-completed" },
  ]);

  assert.equal(tab.resultView, "messages");
  assert.equal(tab.messages.length, 2);
  assert.equal(sqlResultPane(tab), "messages");

  tab.resultView = "results";
  tab.activeResultIndex = 0;
  assert.equal(sqlResultPane(tab), "summary");
  assert.equal(sqlResultStatusText(tab.resultSets[0]), "影响 0 行 · 271 ms");
});

test("write-only SQL execution still switches to messages when columns is missing", () => {
  const tab = sqlTab();
  resetSqlExecution(tab, "exec-ddl");
  applySqlExecutionEvent(tab, {
    type: "statement-started",
    executionId: "exec-ddl",
    statementIndex: 0,
    sql: "ALTER TABLE t ADD COLUMN x int",
    category: "write",
  });
  delete tab.resultSets[0].columns;
  applySqlExecutionEvent(tab, {
    type: "statement-completed",
    executionId: "exec-ddl",
    statementIndex: 0,
    durationMs: 107,
    affectedRows: 0,
    message: "影响 0 行",
  });
  assert.equal(
    applySqlExecutionEvent(tab, { type: "execution-completed", executionId: "exec-ddl" }),
    true,
  );
  assert.equal(tab.resultView, "messages");
});

test("mixed write then select opens the first tabular result instead of an empty placeholder", () => {
  const tab = sqlTab();
  runEvents(tab, "exec-mix", [
    { type: "statement-started", statementIndex: 0, sql: "ALTER TABLE t ADD COLUMN x int", category: "write" },
    { type: "statement-completed", statementIndex: 0, durationMs: 10, affectedRows: 0, message: "影响 0 行" },
    { type: "statement-started", statementIndex: 1, sql: "SELECT 1", category: "read" },
    { type: "result-meta", statementIndex: 1, columns: [{ name: "value" }] },
    { type: "row-batch", statementIndex: 1, rows: [{ value: 1 }] },
    { type: "statement-completed", statementIndex: 1, durationMs: 8, rowCount: 1, message: "返回 1 行" },
    { type: "execution-completed" },
  ]);

  assert.equal(tab.resultView, "results");
  assert.equal(tab.activeResultIndex, 1);
  assert.equal(sqlResultPane(tab), "grid");
  assert.equal(sqlResultStatusText(tab.resultSets[1]), "1 行 · 8 ms");
});

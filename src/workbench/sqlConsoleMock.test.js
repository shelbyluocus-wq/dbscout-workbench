import test from "node:test";
import assert from "node:assert/strict";

import { mockWorkbenchInvoke, resetMockWorkbenchState } from "./mock/mockBackend.js";
import { onMockEvent } from "./mock/mockEventBus.js";

function executeAndCollect(sql, values = {}) {
  return new Promise(async (resolve, reject) => {
    const events = [];
    const stop = onMockEvent("sql-execution-event", (event) => {
      events.push(event.payload);
      if (event.payload.type === "execution-completed") {
        stop();
        resolve(events);
      }
    });
    try {
      const response = await mockWorkbenchInvoke("start_sql_execution", {
        request: {
          connectionId: "demo",
          database: "game_db",
          queryTabId: "tab-sql",
          sql,
          rowLimit: 1000,
          timeoutSeconds: 60,
          ...values,
        },
      });
      events.response = response;
    } catch (error) {
      stop();
      reject(error);
    }
  });
}

test("mock SQL console emits multiple result sets and saves history", async () => {
  resetMockWorkbenchState();
  const events = await executeAndCollect("SELECT * FROM player; SELECT * FROM item;");
  assert.equal(events.filter((event) => event.type === "statement-completed").length, 2);
  assert.equal(events.filter((event) => event.type === "row-batch")[0].rows.length, 3);
  const history = await mockWorkbenchInvoke("list_sql_history", { request: { connectionId: "demo" } });
  assert.equal(history.length, 2);
  assert.equal(history[0].status, "success");

  await mockWorkbenchInvoke("save_sql_favorite", { id: history[0].id, favorite: true, name: "常用道具查询" });
  const favorites = await mockWorkbenchInvoke("list_sql_history", { request: { connectionId: "demo", query: "常用道具" } });
  assert.equal(favorites[0].favorite, true);
  assert.equal(favorites[0].name, "常用道具查询");
});

test("mock SQL console does not split a structured routine body again", async () => {
  resetMockWorkbenchState();
  const routine = "CREATE PROCEDURE p()\nBEGIN\n SELECT 1;\n SELECT 2;\nEND";
  const events = await executeAndCollect(routine, {
    statements: [routine],
    confirmedRisky: true,
  });

  assert.deepEqual(
    events.filter((event) => event.type === "statement-started").map((event) => event.sql),
    [routine],
  );
});

test("mock SQL console reports errors and cancels a long query", async () => {
  resetMockWorkbenchState();
  const errorEvents = await executeAndCollect("SELECT SYNTAX_ERROR");
  assert.equal(errorEvents.some((event) => event.type === "statement-error"), true);

  let jobId = "";
  const completion = new Promise((resolve) => {
    const stop = onMockEvent("sql-execution-event", (event) => {
      if (event.payload.type === "execution-completed") { stop(); resolve(); }
    });
  });
  const response = await mockWorkbenchInvoke("start_sql_execution", { request: {
    connectionId: "demo", database: "game_db", queryTabId: "tab-sql", sql: "SELECT SLEEP(10)", rowLimit: 1000,
  } });
  jobId = response.jobId;
  assert.equal(await mockWorkbenchInvoke("cancel_sql_execution", { jobId }), true);
  await completion;
});

test("mock SQL console requires confirmation for risky writes", async () => {
  resetMockWorkbenchState();
  await assert.rejects(
    mockWorkbenchInvoke("start_sql_execution", { request: {
      connectionId: "demo", database: "game_db", queryTabId: "tab-sql", sql: "DELETE FROM player",
    } }),
    /高风险 SQL/,
  );
});

test("mock SQL files can be saved and reopened from a recent path", async () => {
  resetMockWorkbenchState();
  const saved = await mockWorkbenchInvoke("save_sql_file", { request: { fileName: "players.sql", content: "SELECT * FROM player;" } });
  const opened = await mockWorkbenchInvoke("open_sql_file", { path: saved.path });
  assert.equal(opened.fileName, "players.sql");
  assert.equal(opened.content, "SELECT * FROM player;");
});

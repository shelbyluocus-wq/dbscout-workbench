import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { useTableSession } from "./composables/useTableSession.js";
import { createWorkspaceState, appendTabPage } from "./workspaceState.js";

test("opening a table binds the tab and backend session to its connection and database", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-stage", database: "stage_game" });
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") {
      return { table_name: "hero", table_comment: "英雄配置", columns: [] };
    }
    return {
      sessionId: "stage-hero-session",
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 1000,
    };
  };
  const session = useTableSession(workspace, invoke, {
    busy: ref(false),
    statusText: ref(""),
  });

  await session.openTable({ table_name: "hero" });

  assert.deepEqual(calls[0], {
    command: "get_table_schema",
    payload: { connectionId: "mysql-stage", database: "stage_game", tableName: "hero" },
  });
  assert.deepEqual(calls[1], {
    command: "open_table_session",
    payload: {
      connectionId: "mysql-stage",
      database: "stage_game",
      tableName: "hero",
      options: { page: 1, pageSize: 1000 },
    },
  });
  assert.equal(workspace.tabs[0].connectionId, "mysql-stage");
  assert.equal(workspace.tabs[0].database, "stage_game");
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("a delayed schema from another database does not replace the visible source tree", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "old_db" });
  workspace.schema = [{ table_name: "hero", database: "old_db", columns: [] }];
  const oldSchema = deferred();
  const invoke = async (command, payload) => {
    if (command === "get_table_schema") return oldSchema.promise;
    if (command === "open_table_session") {
      return { sessionId: "old-session", columns: [], rows: [], totalRows: 0, page: 1, pageSize: 1000 };
    }
    return {};
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const opening = session.openTable({ connectionId: "mysql-1", database: "old_db", table_name: "hero" });
  workspace.connectionId = "mysql-1";
  workspace.database = "new_db";
  workspace.schema = [{ table_name: "hero", database: "new_db", columns: [{ column_name: "new_id" }] }];
  oldSchema.resolve({ table_name: "hero", columns: [{ column_name: "old_id" }] });
  await opening;

  assert.equal(workspace.schema[0].database, "new_db");
  assert.deepEqual(workspace.schema[0].columns, [{ column_name: "new_id" }]);
});

test("a slower older page request cannot replace a newer page", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: 1000,
    rows: [],
    columns: [],
    totalRows: 0,
    filter: "",
    sort: null,
  }];
  const pages = new Map([
    [2, deferred()],
    [3, deferred()],
  ]);
  const invoke = async (command, payload) => pages.get(payload.request.page).promise;
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const secondPage = session.fetchPage(tab, 2);
  const thirdPage = session.fetchPage(tab, 3);
  pages.get(3).resolve({ sessionId: "hero-session", columns: [], rows: [{ id: 3 }], totalRows: 3, page: 3, pageSize: 1000 });
  await thirdPage;
  pages.get(2).resolve({ sessionId: "hero-session", columns: [], rows: [{ id: 2 }], totalRows: 3, page: 2, pageSize: 1000 });
  await secondPage;

  assert.equal(tab.page, 3);
  assert.deepEqual(tab.rows, [{ id: 3 }]);
});

test("appendTabPage appends rows and preserves existing columns when later pages omit columns", () => {
  const workspace = createWorkspaceState();
  workspace.tabs = [{
    id: "tab-1",
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 3,
    page: 1,
    pageSize: 1000,
    loading: false,
    loadingMore: false,
  }];

  appendTabPage(workspace, "tab-1", {
    sessionId: "hero-session",
    rows: [{ id: 2 }, { id: 3 }],
    totalRows: 3,
    page: 2,
    pageSize: 1000,
  });

  assert.deepEqual(workspace.tabs[0].rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(workspace.tabs[0].columns, [{ column_name: "id" }]);
  assert.equal(workspace.tabs[0].page, 2);
  assert.equal(workspace.tabs[0].loadingMore, false);
});

test("loadNextPage appends the next backend page and does not send a filter", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: 1000,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 2,
    filter: "needle",
    filterMode: "fuzzy",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ id: 2 }], totalRows: 2, page: 2, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.loadNextPage(workspace.tabs[0]);

  assert.equal(calls[0].payload.request.page, 2);
  assert.equal(calls[0].payload.request.filter, null);
  assert.deepEqual(workspace.tabs[0].rows, [{ id: 1 }, { id: 2 }]);
});

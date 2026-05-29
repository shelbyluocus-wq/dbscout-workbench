import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { REQUEST_PAGE_SIZE } from "./constants.js";
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

test("loadNextPage returns false and skips the backend while a replacement page is loading", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: 1000,
    rows: Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1 })),
    columns: [{ column_name: "id" }],
    totalRows: REQUEST_PAGE_SIZE + 1,
    filter: "",
    sort: null,
    loading: true,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ id: REQUEST_PAGE_SIZE + 1 }], totalRows: REQUEST_PAGE_SIZE + 1, page: 2, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const loaded = await session.loadNextPage(workspace.tabs[0]);

  assert.equal(loaded, false);
  assert.deepEqual(calls, []);
  assert.equal(workspace.tabs[0].loadingMore, false);
});

test("loadNextPage stops future loads after an empty appended page", async () => {
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
    columns: [{ column_name: "id" }],
    totalRows: 5,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [], totalRows: 5, page: 1, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const loaded = await session.loadNextPage(tab);
  const loadedAgain = await session.loadNextPage(tab);

  assert.equal(loaded, false);
  assert.equal(loadedAgain, false);
  assert.equal(tab.loadingMore, false);
  assert.equal(tab.fullyLoaded, true);
  assert.equal(calls.length, 1);
});

test("a stale loadNextPage followed by a newer fetchPage failure clears loadingMore", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: 1000,
    rows: Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1 })),
    columns: [{ column_name: "id" }],
    totalRows: REQUEST_PAGE_SIZE + 2,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const loadMorePage = deferred();
  const replacementPage = deferred();
  const invoke = async (command, payload) => {
    if (payload.request.page === 2) return loadMorePage.promise;
    if (payload.request.page === 3) return replacementPage.promise;
    throw new Error(`unexpected page ${payload.request.page}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const staleAppend = session.loadNextPage(tab);
  assert.equal(tab.loadingMore, true);
  const replacement = session.fetchPage(tab, 3);
  replacementPage.resolve(Promise.reject(new Error("replacement failed")));
  await replacement;
  loadMorePage.resolve({ sessionId: "hero-session", rows: [{ id: REQUEST_PAGE_SIZE + 1 }], totalRows: REQUEST_PAGE_SIZE + 2, page: 2, pageSize: 1000 });
  await staleAppend;

  assert.equal(tab.loadingMore, false);
  assert.equal(tab.loading, false);
  assert.equal(tab.page, 1);
  assert.equal(tab.rows.length, REQUEST_PAGE_SIZE);
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
    rows: Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1 })),
    columns: [{ column_name: "id" }],
    totalRows: REQUEST_PAGE_SIZE + 1,
    filter: "needle",
    filterMode: "fuzzy",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ id: REQUEST_PAGE_SIZE + 1 }], totalRows: REQUEST_PAGE_SIZE + 1, page: 2, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.loadNextPage(workspace.tabs[0]);

  assert.equal(calls[0].payload.request.page, 2);
  assert.equal(calls[0].payload.request.filter, null);
  assert.equal(workspace.tabs[0].rows.length, REQUEST_PAGE_SIZE + 1);
  assert.deepEqual(workspace.tabs[0].rows.at(-1), { id: REQUEST_PAGE_SIZE + 1 });
});

test("loadNextPage derives the next page from the loaded row count", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 7,
    pageSize: 1000,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 2000,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ id: 2 }], totalRows: 2000, page: 2, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.loadNextPage(workspace.tabs[0]);

  assert.equal(calls[0].payload.request.page, 1);
});

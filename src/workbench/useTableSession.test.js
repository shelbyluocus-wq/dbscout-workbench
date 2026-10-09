import test from "node:test";
import assert from "node:assert/strict";
import { nextTick, reactive, ref, watch } from "vue";

import { DEFAULT_PAGE_SIZE, REQUEST_PAGE_SIZE } from "./constants.js";
import { isSessionInvalidError, useTableSession } from "./composables/useTableSession.js";
import { createWorkspaceState, openDatabaseHomeTab, openTableTab, appendTabPage, replaceTabPage } from "./workspaceState.js";
import { ensureTabRowStore } from "./rowStore.js";

test("explicit refresh reads external columns before fetching rows, ordinary paging keeps the cache", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  let columns = [{ name: "id" }];
  const calls = [];
  const session = useTableSession(workspace, async (command) => {
    calls.push(command);
    return { sessionId: "s1", columns, rows: [], totalRows: 0, page: 1, pageSize: 100, hasMore: false };
  }, {
    statusText: ref(""),
    ensureTableSchema: async (_, options) => {
      if (options.force) {
        calls.push("refresh-schema");
        columns = [{ name: "id" }, { name: "external_field" }];
      }
    },
  });
  await session.openTable({ table_name: "hero" });
  const tab = workspace.tabs[0];
  calls.length = 0;
  await session.fetchPage(tab, 1, { refreshSchema: true });
  assert.deepEqual(tab.columns.map((column) => column.name), ["id", "external_field"]);
  assert.deepEqual(calls, ["refresh-schema", "fetch_table_page"]);
  calls.length = 0;
  await session.fetchPage(tab, 2);
  assert.deepEqual(calls, ["fetch_table_page"]);
  await session.dispose();
});

test("a slow schema refresh cannot replace a newer page, and failure retains the visible columns", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  let releaseSchema;
  let schemaFailure = false;
  let pageFetches = 0;
  const statusText = ref("");
  const session = useTableSession(workspace, async (command) => {
    if (command === "fetch_table_page") pageFetches++;
    return { sessionId: "s1", columns: [{ name: "id" }], rows: [], totalRows: 0, page: 1, pageSize: 100, hasMore: false };
  }, {
    statusText,
    ensureTableSchema: async (_, options) => {
      if (!options.force) return;
      if (schemaFailure) throw new Error("offline");
      await new Promise((resolve) => { releaseSchema = resolve; });
    },
  });
  await session.openTable({ table_name: "hero" });
  const tab = workspace.tabs[0];
  const refresh = session.fetchPage(tab, 1, { refreshSchema: true });
  await session.fetchPage(tab, 2);
  releaseSchema();
  assert.equal((await refresh).stale, true);
  assert.equal(pageFetches, 1);
  schemaFailure = true;
  assert.equal((await session.fetchPage(tab, 1, { refreshSchema: true })).ok, false);
  assert.equal(pageFetches, 1);
  assert.equal(tab.loading, false);
  assert.deepEqual(tab.columns.map((column) => column.name), ["id"]);
  assert.match(statusText.value, /刷新字段失败/);
  await session.dispose();
});

test("removing a UI-owned table tab closes its backend session exactly once", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  workspace.tabs.push({
    id: "table-1",
    kind: "data",
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    sessionId: "ui-session-1",
  });
  const calls = [];
  useTableSession(
    workspace,
    async (command, payload) => {
      calls.push({ command, payload });
      if (command === "close_table_session") return { closed: true };
      throw new Error(`unexpected command ${command}`);
    },
    { busy: ref(false), statusText: ref("") },
  );

  workspace.tabs.splice(0, 1);
  await nextTick();
  await Promise.resolve();

  assert.deepEqual(calls, [
    { command: "close_table_session", payload: { sessionId: "ui-session-1" } },
  ]);
});

test("a session returned after its tab was removed is closed instead of leaked", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  let resolveOpen;
  const openResult = new Promise((resolve) => {
    resolveOpen = resolve;
  });
  const calls = [];
  const session = useTableSession(
    workspace,
    async (command, payload) => {
      calls.push({ command, payload });
      if (command === "open_table_session") return openResult;
      if (command === "close_table_session") return { closed: true };
      if (command === "get_table_schema") return { table_name: "player", columns: [] };
      throw new Error(`unexpected command ${command}`);
    },
    { busy: ref(false), statusText: ref("") },
  );

  const opening = session.openTable({ table_name: "player" });
  await Promise.resolve();
  workspace.tabs.splice(0, 1);
  resolveOpen({
    sessionId: "late-session",
    tableName: "player",
    columns: [],
    rows: [],
    totalRows: 0,
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
  });
  await opening;
  await Promise.resolve();

  assert.deepEqual(
    calls.filter((call) => call.command === "close_table_session").map((call) => call.payload),
    [{ sessionId: "late-session" }],
  );
});

test("disposing table-session ownership closes every remaining UI session", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  workspace.tabs.push(
    { id: "table-1", kind: "data", sessionId: "ui-session-1" },
    { id: "table-2", kind: "data", sessionId: "ui-session-2" },
  );
  const calls = [];
  const session = useTableSession(
    workspace,
    async (command, payload) => {
      calls.push({ command, payload });
      return { closed: true };
    },
    { busy: ref(false), statusText: ref("") },
  );

  await session.dispose();

  assert.deepEqual(
    calls.map((call) => call.payload.sessionId).sort(),
    ["ui-session-1", "ui-session-2"],
  );
});

test("disposing table sessions cancels active search jobs before closing sessions", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  workspace.tabs.push({
    id: "table-1",
    kind: "data",
    sessionId: "ui-session-1",
    searchResultJobId: "job-1",
  });
  const calls = [];
  const session = useTableSession(
    workspace,
    async (command, payload) => {
      calls.push({ command, payload });
      return command === "cancel_table_search" ? { cancelled: true } : { closed: true };
    },
    { busy: ref(false), statusText: ref("") },
  );

  await session.dispose();

  assert.deepEqual(calls.map((call) => call.command), [
    "cancel_table_search",
    "close_table_session",
  ]);
});

test("opening a table binds the tab and backend session to its connection and database", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-stage", database: "stage_game" });
  const calls = [];
  const schemaRequests = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
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
    ensureTableSchema: async (tableName, options) => {
      schemaRequests.push({ tableName, options });
      return { table_name: tableName, table_comment: "英雄配置", columns: [] };
    },
  });

  await session.openTable({ table_name: "hero" });
  // Allow the shared metadata coordinator refresh (fire-and-forget) to flush.
  await Promise.resolve();

  const sessionCall = calls.find((c) => c.command === "open_table_session");
  assert.deepEqual(schemaRequests, [{
    tableName: "hero",
    options: { connectionId: "mysql-stage", database: "stage_game", priority: "recent" },
  }]);
  assert.deepEqual(sessionCall, {
    command: "open_table_session",
    payload: {
      connectionId: "mysql-stage",
      database: "stage_game",
      tableName: "hero",
      options: { page: 1, pageSize: DEFAULT_PAGE_SIZE, includeTotal: false },
    },
  });
  assert.equal(workspace.tabs[0].connectionId, "mysql-stage");
  assert.equal(workspace.tabs[0].database, "stage_game");
});

test("table sessions never create a second direct schema request owner", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-stage", database: "stage_game" });
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "open_table_session") {
      return {
        sessionId: "stage-hero-session",
        columns: [],
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize: 1000,
      };
    }
    return { table_name: "hero", columns: [] };
  };
  const session = useTableSession(workspace, invoke, {
    busy: ref(false),
    statusText: ref(""),
  });

  await session.openTable({ table_name: "hero" });
  await Promise.resolve();

  assert.deepEqual(calls.map((call) => call.command), ["open_table_session"]);
});

test("openTable returns the opened tab after loading", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game_db" });
  workspace.schema = [{ table_name: "player", table_comment: "玩家账号表", columns: [{ column_name: "id", is_primary_key: true }] }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return workspace.schema[0];
    if (command === "open_table_session") {
      return {
        sessionId: "s1",
        tableName: "player",
        tableComment: "玩家账号表",
        columns: [{ column_name: "id", is_primary_key: true }],
        primaryKeys: ["id"],
        rows: [{ id: "1" }],
        totalRows: 1,
        page: 1,
        pageSize: 1000,
      };
    }
    throw new Error(command);
  };
  const busy = { value: false };
  const statusText = { value: "" };
  const { openTable } = useTableSession(workspace, invoke, { busy, statusText });

  const tab = await openTable({ tableName: "player", connectionId: "demo", database: "game_db" });

  assert.equal(tab.tableName, "player");
  assert.equal(tab.sessionId, "s1");
  assert.equal(workspace.activeTabId, tab.id);
});

test("openTable returns the reactive workspace tab for follow-up schema highlights", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "demo", database: "game_db" }));
  const invoke = async (command) => {
    if (command === "get_table_schema") {
      return {
        table_name: "player",
        table_comment: "玩家账号表",
        columns: [{ column_name: "nickname", column_comment: "昵称" }],
      };
    }
    if (command === "open_table_session") {
      return {
        sessionId: "s1",
        columns: [{ column_name: "nickname", column_comment: "昵称" }],
        rows: [{ nickname: "冒险者001" }],
        totalRows: 1,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(command);
  };
  const { openTable } = useTableSession(workspace, invoke, {
    busy: ref(false),
    statusText: ref(""),
  });

  const tab = await openTable({ tableName: "player" });
  let observedLength = -1;
  const stop = watch(
    () => workspace.tabs[0]?.schemaSearchMatches?.length ?? 0,
    (length) => {
      observedLength = length;
    },
  );

  tab.schemaSearchMatches = [{ columnName: "nickname", matchKind: "columnComment" }];
  await nextTick();
  stop();

  assert.equal(tab, workspace.tabs[0]);
  assert.equal(observedLength, 1);
});

test("normal table search state stays local when opening a backend session", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }, { column_name: "name" }],
        rows: [{ id: 1, name: "Needle" }],
        totalRows: 1,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await openTable({ table_name: "hero" }, {
    initialState: {
      filter: "needle",
      searchQuery: "needle",
      filterMode: "exact",
      sort: { columnName: "name", descending: true },
    },
  });

  const openCall = calls.find((call) => call.command === "open_table_session");
  assert.deepEqual(openCall.payload.options, {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    includeTotal: false,
    sort: { columnName: "name", descending: true },
  });
  assert.equal(tab.filter, "needle");
  assert.equal(tab.searchQuery, "needle");
  assert.equal(tab.filterMode, "exact");
  assert.equal(tab.hitResultMode, false);
});

test("hit result tabs send the search filter while opening and counting", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const rows = Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1, note: "needle" }));
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }, { column_name: "note" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-hit-session",
        columns: [{ column_name: "id" }, { column_name: "note" }],
        rows,
        totalRows: rows.length,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    if (command === "fetch_table_count") {
      return {
        totalRows: 42,
        exact: true,
        estimated: false,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await openTable({ table_name: "hero" }, {
    initialState: {
      filter: "needle",
      searchQuery: "needle",
      filterMode: "exact",
      hitResultMode: true,
      hitResultSourceTabId: "tab-source",
      hitResultSourcePaneId: "pane-source",
    },
  });
  await waitForTimers();
  await Promise.resolve();

  const openCall = calls.find((call) => call.command === "open_table_session");
  const countCall = calls.find((call) => call.command === "fetch_table_count");
  assert.deepEqual(openCall.payload.options.filter, {
    query: "needle",
    columns: [],
    mode: "exact",
  });
  assert.deepEqual(countCall.payload.filter, {
    query: "needle",
    columns: [],
    mode: "exact",
  });
  assert.equal(tab.hitResultMode, true);
  assert.equal(tab.hitResultSourceTabId, "tab-source");
  assert.equal(tab.hitResultSourcePaneId, "pane-source");
});

test("hit result tabs send the search filter while refreshing and loading more", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-hit-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1 })),
    columns: [{ column_name: "id" }, { column_name: "note" }],
    totalRows: REQUEST_PAGE_SIZE + 1,
    totalRowsExact: false,
    hasMore: true,
    filter: "needle",
    filterMode: "exact",
    hitResultMode: true,
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {
      sessionId: "hero-hit-session",
      columns: [{ column_name: "id" }, { column_name: "note" }],
      rows: [{ id: payload.request.page }],
      totalRows: REQUEST_PAGE_SIZE + 1,
      totalRowsExact: false,
      hasMore: payload.request.page < 2,
      page: payload.request.page,
      pageSize: REQUEST_PAGE_SIZE,
    };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  await session.fetchPage(tab, 1);
  tab.rows = Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1 }));
  tab.hasMore = true;
  tab.fullyLoaded = false;
  await session.loadNextPage(tab);

  assert.deepEqual(calls[0].payload.request.filter, {
    query: "needle",
    columns: [],
    mode: "exact",
  });
  assert.deepEqual(calls[1].payload.request.filter, {
    query: "needle",
    columns: [],
    mode: "exact",
  });
});

test("loadSearchResultPage starts a backend job in an isolated result RowStore", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [{ id: 1, note: "loaded only" }],
    columns: [{ column_name: "id" }, { column_name: "note" }],
    totalRows: REQUEST_PAGE_SIZE,
    totalRowsExact: false,
    hasMore: true,
    filter: "",
    searchQuery: "",
    filterMode: "exact",
    hitResultMode: false,
    searchResultMode: false,
    sort: { columnName: "id", descending: true },
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {
      jobId: "job-1",
      rows: [{ id: 9001, note: "needle" }],
      rowKeys: ["id=9001"],
      matches: [{ rowIndex: 0, sourceRowIndex: 9000, columnIndex: 1, columnName: "note", kind: "exact", rank: 0, score: 0, ranges: [{ start: 0, end: 6 }] }],
      scannedRows: 128,
      complete: false,
    };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];
  const normalStore = ensureTabRowStore(tab);
  const insertDrafts = [{ id: "insert-1", draft: { note: "unsaved" } }];
  tab.insertDrafts = insertDrafts;

  const loaded = await session.loadSearchResultPage(tab, "needle");

  assert.equal(loaded.ok, true);
  assert.equal(calls[0].command, "begin_table_search");
  assert.deepEqual(calls[0].payload.request, {
    sessionId: "hero-session",
    query: "needle",
    mode: "exact",
    sort: { columnName: "id", descending: true },
    resultPageSize: 100,
  });
  assert.equal(tab.normalViewState.rowStore, normalStore);
  assert.notEqual(tab.rowStore, normalStore);
  assert.deepEqual(tab.rows, [{ id: 9001, note: "needle" }]);
  assert.deepEqual(tab.searchResultRowKeys, ["id=9001"]);
  assert.equal(tab.searchResultMatches[0].sourceRowIndex, 9000);
  assert.equal(tab.searchResultJobId, "job-1");
  assert.equal(tab.searchResultComplete, false);
  assert.equal(tab.searchResultMode, true);
  assert.equal(tab.searchResultQuery, "needle");
  assert.equal(tab.hitResultMode, false);
  assert.equal(tab.insertDrafts, insertDrafts);
});

test("clearing a search result page cancels its job and restores the original RowStore", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [{ id: 1, note: "first page" }],
    columns: [{ column_name: "id" }, { column_name: "note" }],
    totalRows: REQUEST_PAGE_SIZE,
    totalRowsExact: false,
    hasMore: true,
    filter: "",
    searchQuery: "",
    filterMode: "fuzzy",
    hitResultMode: false,
    searchResultMode: false,
    searchResultQuery: "",
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "begin_table_search") {
      return {
        jobId: "job-restore",
        rows: [{ id: 9001, note: "needle" }],
        rowKeys: ["id=9001"],
        matches: [{ rowIndex: 0, sourceRowIndex: 9000, columnIndex: 1, columnName: "note", kind: "contains", rank: 2, score: 0, ranges: [{ start: 0, end: 6 }] }],
        scannedRows: 128,
        complete: false,
      };
    }
    return { cancelled: true };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];
  const normalStore = ensureTabRowStore(tab);
  await session.loadSearchResultPage(tab, "needle");

  const loaded = await session.loadSearchResultPage(tab, "");

  assert.equal(loaded.ok, true);
  assert.equal(loaded.restored, true);
  assert.deepEqual(calls.map((call) => call.command), ["begin_table_search", "cancel_table_search"]);
  assert.deepEqual(calls[1].payload, { jobId: "job-restore" });
  assert.equal(tab.rowStore, normalStore);
  assert.equal(tab.searchResultMode, false);
  assert.equal(tab.searchResultQuery, "");
  assert.deepEqual(tab.rows, [{ id: 1, note: "first page" }]);
});

test("search continuation keeps a bounded 500-row result buffer and adjusts match indexes", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    rows: [{ id: -1 }],
    columns: [{ column_name: "id" }, { column_name: "note" }],
    primaryKeys: ["id"],
    filterMode: "fuzzy",
    sort: null,
  }];
  const firstRows = Array.from({ length: 400 }, (_, id) => ({ id, note: "needle" }));
  const nextRows = Array.from({ length: 200 }, (_, index) => ({ id: 400 + index, note: "needle" }));
  const makeMatches = (count) => Array.from({ length: count }, (_, rowIndex) => ({
    rowIndex,
    sourceRowIndex: rowIndex,
    columnIndex: 1,
    columnName: "note",
    kind: "exact",
    rank: 0,
    score: 0,
    ranges: [{ start: 0, end: 6 }],
  }));
  const invoke = async (command) => command === "begin_table_search"
    ? { jobId: "job-buffer", rows: firstRows, rowKeys: firstRows.map((row) => `id=${row.id}`), matches: makeMatches(400), scannedRows: 400, complete: false }
    : { jobId: "job-buffer", rows: nextRows, rowKeys: nextRows.map((row) => `id=${row.id}`), matches: makeMatches(200), scannedRows: 600, complete: true };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];
  await session.loadSearchResultPage(tab, "needle");

  const loaded = await session.loadNextSearchResultPage(tab);

  assert.equal(loaded.ok, true);
  assert.equal(tab.rows.length, 500);
  assert.equal(tab.rows[0].id, 100);
  assert.equal(tab.rows.at(-1).id, 599);
  assert.equal(tab.searchResultRowKeys[0], "id=100");
  assert.equal(tab.searchResultMatches[0].rowIndex, 0);
  assert.equal(tab.searchResultMatches.at(-1).rowIndex, 499);
  assert.equal(tab.searchResultComplete, true);
});

test("a stale search response is cancelled and cannot replace the latest result page", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1", connectionId: "mysql-1", database: "game", tableName: "hero", sessionId: "hero-session",
    rows: [{ id: 1 }], columns: [{ column_name: "id" }], primaryKeys: ["id"], filterMode: "fuzzy", sort: null,
  }];
  const oldGate = deferred();
  const newGate = deferred();
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "cancel_table_search") return { cancelled: true };
    return payload.request.query === "old" ? oldGate.promise : newGate.promise;
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];
  const oldSearch = session.loadSearchResultPage(tab, "old");
  const newSearch = session.loadSearchResultPage(tab, "new");
  newGate.resolve({ jobId: "job-new", rows: [{ id: 2 }], rowKeys: ["id=2"], matches: [], scannedRows: 128, complete: true });
  await newSearch;
  oldGate.resolve({ jobId: "job-old", rows: [{ id: 1 }], rowKeys: ["id=1"], matches: [], scannedRows: 128, complete: true });

  const stale = await oldSearch;

  assert.equal(stale.stale, true);
  assert.deepEqual(tab.rows, [{ id: 2 }]);
  assert.equal(tab.searchResultJobId, "job-new");
  assert.ok(calls.some((call) => call.command === "cancel_table_search" && call.payload.jobId === "job-old"));
});

test("sorting an active search restarts the backend job without touching insert drafts", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const drafts = [{ id: "insert-1", draft: { name: "unsaved" } }];
  workspace.tabs = [{
    id: "tab-1", connectionId: "mysql-1", database: "game", tableName: "hero", sessionId: "hero-session",
    rows: [{ id: 1 }], columns: [{ column_name: "id" }], primaryKeys: ["id"], filterMode: "fuzzy", sort: null,
    insertDrafts: drafts,
  }];
  let sequence = 0;
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "cancel_table_search") return { cancelled: true };
    sequence += 1;
    return { jobId: `job-${sequence}`, rows: [{ id: sequence }], rowKeys: [`id=${sequence}`], matches: [], scannedRows: 128, complete: true };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];
  await session.loadSearchResultPage(tab, "needle");

  await session.applySort(tab, "id", "descending");

  const begins = calls.filter((call) => call.command === "begin_table_search");
  assert.equal(begins.length, 2);
  assert.deepEqual(begins[1].payload.request.sort, { columnName: "id", descending: true });
  assert.equal(tab.insertDrafts, drafts);
});

test("opening a normal table does not reuse an existing hit result tab in the same pane", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    kind: "data",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    tableKey: "mysql-1\u001fgame\u001fhero",
    sessionId: "hero-hit-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 1,
    filter: "needle",
    searchQuery: "needle",
    filterMode: "fuzzy",
    hitResultMode: true,
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  workspace.panes["pane-1"].tabIds = ["tab-1"];
  workspace.panes["pane-1"].activeTabId = "tab-1";
  workspace.activeTabId = "tab-1";
  workspace.nextTabSeq = 2;
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-normal-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 2 }],
        totalRows: 1,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await openTable({ table_name: "hero" }, { paneId: "pane-1" });

  assert.equal(tab.id, "tab-2");
  assert.equal(tab.hitResultMode, false);
  assert.deepEqual(workspace.panes["pane-1"].tabIds, ["tab-1", "tab-2"]);
  assert.equal(calls.find((call) => call.command === "open_table_session").payload.options.filter, undefined);
});

test("opening a hit result table does not reuse an existing normal tab across panes", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const existingTab = {
    id: "tab-1",
    kind: "data",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    tableKey: "mysql-1gamehero",
    sessionId: "hero-normal-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [{ id: 1, note: "normal page" }],
    columns: [{ column_name: "id" }, { column_name: "note" }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    filter: "",
    searchQuery: "",
    filterMode: "fuzzy",
    hitResultMode: false,
    searchResultMode: false,
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: true,
    loadError: null,
  };
  workspace.tabs = [existingTab];
  workspace.panes["pane-1"].tabIds = [existingTab.id];
  workspace.panes["pane-1"].activeTabId = existingTab.id;
  workspace.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  workspace.layout = {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "pane", paneId: "pane-1" },
    second: { type: "pane", paneId: "pane-2" },
  };
  workspace.focusedPaneId = "pane-2";
  workspace.activeTabId = existingTab.id;
  workspace.nextTabSeq = 2;
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }, { column_name: "note" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-hit-session",
        columns: [{ column_name: "id" }, { column_name: "note" }],
        rows: [{ id: 2, note: "needle" }],
        totalRows: 1,
        totalRowsExact: true,
        hasMore: false,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await openTable({ table_name: "hero" }, {
    paneId: "pane-2",
    initialState: {
      filter: "needle",
      searchQuery: "needle",
      filterMode: "exact",
      hitResultMode: true,
    },
  });

  assert.notEqual(tab.id, existingTab.id);
  assert.equal(tab.hitResultMode, true);
  assert.deepEqual(workspace.panes["pane-1"].tabIds, [existingTab.id]);
  assert.deepEqual(workspace.panes["pane-2"].tabIds, [tab.id]);
  const openCall = calls.find((call) => call.command === "open_table_session");
  assert.ok(openCall);
  assert.deepEqual(openCall.payload.options.filter, {
    query: "needle",
    columns: [],
    mode: "exact",
  });
});

test("opening a normal table retries an existing failed tab instead of reusing the empty state", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const existingTab = {
    id: "tab-1",
    kind: "data",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    tableKey: "mysql-1\u001fgame\u001fhero",
    sessionId: "",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [],
    columns: [],
    totalRows: 0,
    totalRowsExact: false,
    hasMore: false,
    filter: "",
    searchQuery: "",
    filterMode: "fuzzy",
    hitResultMode: false,
    searchResultMode: false,
    searchResultQuery: "",
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
    loadError: "previous timeout",
  };
  workspace.tabs = [existingTab];
  workspace.panes["pane-1"].tabIds = [existingTab.id];
  workspace.panes["pane-1"].activeTabId = existingTab.id;
  workspace.focusedPaneId = "pane-1";
  workspace.activeTabId = existingTab.id;
  workspace.nextTabSeq = 2;
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") {
      return {
        table_name: "hero",
        columns: [{ column_name: "id", is_primary_key: true }],
        primaryKeys: ["id"],
      };
    }
    if (command === "open_table_session") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        primaryKeys: ["id"],
        rows: [{ id: 1 }],
        totalRows: 1,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await openTable({ table_name: "hero" }, { paneId: "pane-1" });

  assert.equal(tab, existingTab);
  assert.equal(workspace.tabs.length, 1);
  assert.ok(calls.some((call) => call.command === "open_table_session"));
  assert.equal(existingTab.sessionId, "hero-session");
  assert.equal(existingTab.loadError, null);
  assert.deepEqual(existingTab.rows, [{ id: 1 }]);
  assert.equal(workspace.activeTabId, existingTab.id);
  assert.equal(workspace.panes["pane-1"].activeTabId, existingTab.id);
});

test("opening a normal table clears an existing search-result tab and loads the unfiltered first page", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const existingTab = {
    id: "tab-1",
    kind: "data",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    tableKey: "mysql-1\u001fgame\u001fhero",
    sessionId: "hero-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [],
    columns: [{ column_name: "id" }, { column_name: "note" }],
    totalRows: 0,
    totalRowsExact: false,
    hasMore: false,
    filter: "needle",
    searchQuery: "needle",
    filterMode: "fuzzy",
    hitResultMode: false,
    searchResultMode: true,
    searchResultQuery: "needle",
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: true,
    loadError: null,
  };
  workspace.tabs = [existingTab];
  workspace.panes["pane-1"].tabIds = [existingTab.id];
  workspace.panes["pane-1"].activeTabId = existingTab.id;
  workspace.focusedPaneId = "pane-1";
  workspace.activeTabId = existingTab.id;
  workspace.nextTabSeq = 2;
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "fetch_table_page") {
      return {
        sessionId: "hero-session",
        rows: [{ id: 1, note: "first page" }],
        totalRows: REQUEST_PAGE_SIZE,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await openTable({ table_name: "hero" }, { paneId: "pane-1" });

  assert.equal(tab, existingTab);
  assert.equal(workspace.tabs.length, 1);
  const pageCall = calls.find((call) => call.command === "fetch_table_page");
  assert.ok(pageCall);
  assert.deepEqual(pageCall.payload, {
    sessionId: "hero-session",
    request: {
      page: 1,
      pageSize: REQUEST_PAGE_SIZE,
      includeTotal: false,
      filter: null,
      sort: null,
    },
  });
  assert.equal(existingTab.searchResultMode, false);
  assert.equal(existingTab.searchResultQuery, "");
  assert.equal(existingTab.filter, "");
  assert.equal(existingTab.searchQuery, "");
  assert.deepEqual(existingTab.rows, [{ id: 1, note: "first page" }]);
});

test("reopening a healthy table reuses it without reloading or resetting its view", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const existingTab = {
    id: "tab-1",
    kind: "data",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    tableKey: "mysql-1\u001fgame\u001fhero",
    sessionId: "hero-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [{ id: 1, name: "needle" }],
    columns: [{ column_name: "id" }, { column_name: "name" }],
    totalRows: 77,
    filter: "needle",
    searchQuery: "needle",
    filterMode: "fuzzy",
    hitResultMode: false,
    sort: { columnName: "id", descending: false },
    selectedRowKeys: new Set(["id=1"]),
    schemaSearchQuery: "name",
    schemaSearchMatches: [{ columnName: "name" }],
    schemaSearchIndex: 0,
    tableViewRevision: 3,
    tableViewState: { revision: 3, scrollTop: 280, scrollLeft: 64, editor: null },
    loading: false,
    loadingMore: false,
  };
  workspace.tabs = [existingTab];
  workspace.panes["pane-1"].tabIds = [existingTab.id];
  workspace.panes["pane-1"].activeTabId = existingTab.id;
  workspace.focusedPaneId = "pane-1";
  workspace.activeTabId = existingTab.id;
  workspace.nextTabSeq = 2;
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("ready") });

  const tab = await openTable({ table_name: "hero" }, { paneId: "pane-1" });

  assert.equal(tab, existingTab);
  assert.deepEqual(calls, []);
  assert.equal(workspace.tabs.length, 1);
  assert.deepEqual(existingTab.rows, [{ id: 1, name: "needle" }]);
  assert.equal(existingTab.searchQuery, "needle");
  assert.equal(existingTab.filter, "needle");
  assert.equal(existingTab.filterMode, "fuzzy");
  assert.deepEqual(existingTab.sort, { columnName: "id", descending: false });
  assert.deepEqual([...existingTab.selectedRowKeys], ["id=1"]);
  assert.equal(existingTab.schemaSearchQuery, "name");
  assert.deepEqual(existingTab.schemaSearchMatches, [{ columnName: "name" }]);
  assert.equal(existingTab.schemaSearchIndex, 0);
  assert.equal(existingTab.tableViewRevision, 3);
  assert.deepEqual(existingTab.tableViewState, {
    revision: 3,
    scrollTop: 280,
    scrollLeft: 64,
    editor: null,
  });
  assert.equal(existingTab.loading, false);
  assert.equal(workspace.activeTabId, existingTab.id);
  assert.equal(workspace.panes["pane-1"].activeTabId, existingTab.id);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForTimers() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("openTable computes the exact total in the background after the first page is usable", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const rows = Array.from({ length: REQUEST_PAGE_SIZE }, (_, index) => ({ id: index + 1 }));
  const calls = [];
  const statusText = ref("");
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        rows,
        totalRows: rows.length,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    if (command === "fetch_table_count") {
      return {
        totalRows: 12345,
        exact: true,
        estimated: false,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText });

  const tab = await openTable({ table_name: "hero" });

  const openCall = calls.find((call) => call.command === "open_table_session");
  assert.equal(openCall.payload.options.includeTotal, false);
  assert.equal(tab.totalRows, REQUEST_PAGE_SIZE);
  assert.equal(tab.totalRowsExact, false);
  assert.equal(tab.totalRowsLoading, true);
  assert.match(statusText.value, /已加载 1000\+ 行/);
  assert.match(statusText.value, /总数计算中/);

  await waitForTimers();
  await Promise.resolve();

  const countCall = calls.find((call) => call.command === "fetch_table_count");
  assert.ok(countCall, "exact totals must use the dedicated count command");
  assert.equal(countCall.payload.sessionId, "hero-session");
  assert.equal(typeof countCall.payload.requestId, "string");
  assert.ok(countCall.payload.requestId.length > 0);
  assert.equal(countCall.payload.filter, null);
  assert.equal(calls.some((call) => call.command === "fetch_table_page"), false);
  assert.equal(tab.rows, rows);
  assert.equal(tab.rows.length, REQUEST_PAGE_SIZE);
  assert.equal(tab.totalRows, 12345);
  assert.equal(tab.totalRowsExact, true);
  assert.equal(tab.totalRowsLoading, false);
  assert.equal(statusText.value, "game.hero：12345 行");
});

test("background exact total ignores stale sessions and keeps count failures non-blocking", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const count = deferred();
  let countAttempts = 0;
  const statusText = ref("");
  const invoke = async (command, payload) => {
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 1 }],
        totalRows: 1,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    if (command === "fetch_table_count") {
      countAttempts += 1;
      return count.promise;
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { openTable } = useTableSession(workspace, invoke, { busy: ref(false), statusText });

  const tab = await openTable({ table_name: "hero" });
  await waitForTimers();
  assert.equal(countAttempts, 1);
  tab.sessionId = "replacement-session";
  count.resolve({
    totalRows: 999,
    exact: true,
    estimated: false,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(tab.totalRows, 1);
  assert.equal(tab.totalRowsExact, false);
  assert.equal(tab.totalRowsLoading, false);
  assert.equal(tab.totalRowsError, "");
  assert.equal(statusText.value, "game.hero：已加载 1+ 行");

  const failingCount = deferred();
  const invokeFailingCount = async (command) => {
    if (command === "get_table_schema") return { table_name: "item", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "item-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 1 }],
        totalRows: 1,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    if (command === "fetch_table_count") return failingCount.promise;
    throw new Error(`unexpected command ${command}`);
  };
  const failingWorkspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const failingStatusText = ref("");
  const failingSession = useTableSession(failingWorkspace, invokeFailingCount, { busy: ref(false), statusText: failingStatusText });

  const failingTab = await failingSession.openTable({ table_name: "item" });
  await waitForTimers();
  failingCount.reject(new Error("count timeout"));
  await waitForTimers();

  assert.deepEqual(failingTab.rows, [{ id: 1 }]);
  assert.equal(failingTab.totalRows, 1);
  assert.equal(failingTab.totalRowsExact, false);
  assert.equal(failingTab.totalRowsLoading, false);
  assert.match(failingTab.totalRowsError, /count timeout/);
  assert.equal(failingStatusText.value, "game.item：已加载 1+ 行");
});

test("a replacement page cancels the pending backend count request", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const count = deferred();
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 1 }],
        totalRows: 1,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    if (command === "fetch_table_count") {
      return count.promise;
    }
    if (command === "cancel_table_count") return { cancelled: true };
    if (command === "fetch_table_page") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 2 }],
        totalRows: 2,
        totalRowsExact: false,
        hasMore: true,
        page: payload.request.page,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const tab = await session.openTable({ table_name: "hero" });
  await waitForTimers();
  const countCall = calls.find((call) => call.command === "fetch_table_count");
  assert.ok(countCall, "background counting must start through fetch_table_count");
  await session.fetchPage(tab, 2);
  const cancelCall = calls.find((call) => call.command === "cancel_table_count");
  assert.deepEqual(cancelCall?.payload, { requestId: countCall.payload.requestId });
  count.resolve({
    totalRows: 999,
    exact: true,
    estimated: false,
  });
  await waitForTimers();

  assert.deepEqual(tab.rows, [{ id: 2 }]);
  assert.equal(tab.totalRows, 2);
  assert.equal(tab.totalRowsExact, false);
  assert.equal(tab.hasMore, true);
  assert.equal(tab.totalRowsLoading, false);
});

test("closing a tab cancels its active backend count before closing the session", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "mysql-1", database: "game" }));
  const count = deferred();
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return { table_name: "hero", columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 1 }],
        totalRows: 1,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: REQUEST_PAGE_SIZE,
      };
    }
    if (command === "fetch_table_count") return count.promise;
    if (command === "cancel_table_count") return { cancelled: true };
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const openedTab = await session.openTable({ table_name: "hero" });
  await waitForTimers();
  const countCall = calls.find((call) => call.command === "fetch_table_count");
  assert.ok(countCall, "background counting must start through fetch_table_count");

  workspace.tabs.splice(workspace.tabs.indexOf(openedTab), 1);
  await nextTick();
  await Promise.resolve();

  const relevantCalls = calls.filter((call) => ["cancel_table_count", "close_table_session"].includes(call.command));
  assert.deepEqual(relevantCalls, [
    { command: "cancel_table_count", payload: { requestId: countCall.payload.requestId } },
    { command: "close_table_session", payload: { sessionId: "hero-session" } },
  ]);
  count.resolve({ totalRows: 999, exact: true, estimated: false });
});

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
  // flush the background get_table_schema (fire-and-forget) microtasks
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(workspace.schema[0].database, "new_db");
  assert.deepEqual(workspace.schema[0].columns, [{ column_name: "new_id" }]);
});

test("opening a new table keeps the current tab active until the first page is ready", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "items",
    tableKey: "mysql-1\u001fgame\u001fitems",
    sessionId: "items-session",
    page: 1,
    pageSize: 1000,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 1,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  workspace.activeTabId = "tab-1";
  workspace.nextTabSeq = 2;
  const schema = deferred();
  const page = deferred();
  const invoke = async (command) => {
    if (command === "get_table_schema") return schema.promise;
    if (command === "open_table_session") return page.promise;
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const opening = session.openTable({ table_name: "quests" });

  assert.equal(workspace.activeTabId, "tab-1");
  assert.equal(workspace.tabs.length, 2);
  schema.resolve({ table_name: "quests", columns: [{ column_name: "quest_id", is_primary_key: true }] });
  await Promise.resolve();
  assert.equal(workspace.activeTabId, "tab-1");

  page.resolve({
    sessionId: "quests-session",
    columns: [{ column_name: "quest_id", is_primary_key: true }],
    rows: [{ quest_id: 7 }],
    totalRows: 1,
    page: 1,
    pageSize: 1000,
  });
  await opening;

  assert.equal(workspace.activeTabId, "tab-2");
  assert.deepEqual(workspace.tabs[1].rows, [{ quest_id: 7 }]);
});

test("new table stays provisional until its first page is ready", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const page = deferred();
  const busy = ref(false);
  const invoke = async (command) => {
    if (command === "open_table_session") return page.promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy, statusText: ref("") });

  const opening = session.openTable({ tableName: "player" });
  const pending = workspace.tabs.find((tab) => tab.tableName === "player");
  assert.equal(pending.opening, true);
  assert.equal(workspace.activeTabId, current.id);
  assert.equal(busy.value, false);
  assert.equal(session.pendingTableOpenCount.value, 1);

  page.resolve({
    sessionId: "player-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  const loaded = await opening;

  assert.equal(loaded.opening, false);
  assert.equal(workspace.activeTabId, loaded.id);
  assert.deepEqual(loaded.rows, [{ id: 1 }]);
  assert.equal(session.pendingTableOpenCount.value, 0);
});

test("a ready 100-row first page schedules the remaining 900-row buffer automatically", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "open_table_session") {
      return {
        sessionId: "player-session",
        columns: [{ column_name: "id" }],
        rows: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        totalRows: 100,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: 100,
      };
    }
    if (command === "fetch_table_page") {
      return {
        sessionId: "player-session",
        columns: [{ column_name: "id" }],
        rows: Array.from({ length: 900 }, (_, index) => ({ id: index + 101 })),
        totalRows: 1000,
        totalRowsExact: false,
        hasMore: true,
        page: 1,
        pageSize: 900,
      };
    }
    if (command === "fetch_table_count") return { totalRows: 2000, exact: true, estimated: false };
    if (command === "cancel_table_count") return { cancelled: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { statusText: ref("") });

  const tab = await session.openTable({ tableName: "player" });
  assert.equal(tab.opening, false);
  assert.equal(tab.rows.length, 100);
  assert.equal(calls.find((call) => call.command === "open_table_session").payload.options.pageSize, 100);

  for (let turn = 0; turn < 50 && tab.rows.length < 1000; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const fill = calls.find((call) => call.command === "fetch_table_page");
  assert.deepEqual(
    { offset: fill?.payload.request.offset, pageSize: fill?.payload.request.pageSize },
    { offset: 100, pageSize: 900 },
  );
  assert.equal(tab.rows.length, 1000);
  assert.deepEqual(tab.rows.map((row) => row.id), Array.from({ length: 1000 }, (_, index) => index + 1));
});

test("repeated opens reuse one provisional table request", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  openTableTab(workspace, { tableName: "current" }, { activate: true }).sessionId = "current-session";
  const page = deferred();
  let openCalls = 0;
  const invoke = async (command) => {
    if (command === "open_table_session") {
      openCalls += 1;
      return page.promise;
    }
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const first = session.openTable({ tableName: "player" });
  const second = session.openTable({ tableName: "player" });
  assert.equal(openCalls, 1);

  page.resolve({
    sessionId: "player-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  const [firstTab, secondTab] = await Promise.all([first, second]);

  assert.equal(firstTab, secondTab);
  assert.equal(workspace.tabs.filter((tab) => tab.tableName === "player").length, 1);
});

test("failed provisional open is removed without changing the current table", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const invoke = async (command) => {
    if (command === "open_table_session") throw new Error("offline");
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const loaded = await session.openTable({ tableName: "player" });

  assert.equal(loaded, null);
  assert.equal(workspace.activeTabId, current.id);
  assert.equal(workspace.tabs.some((tab) => tab.tableName === "player"), false);
  assert.equal(session.pendingTableOpenCount.value, 0);
});

test("overlapping opens retain progress and only the latest activation wins", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const pages = new Map([["alpha", deferred()], ["beta", deferred()]]);
  const payload = (name) => ({
    sessionId: `${name}-session`,
    columns: [{ column_name: "id" }],
    rows: [{ id: name }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  const invoke = async (command, request) => {
    if (command === "open_table_session") return pages.get(request.tableName).promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const alpha = session.openTable({ tableName: "alpha" });
  const beta = session.openTable({ tableName: "beta" });
  assert.equal(session.pendingTableOpenCount.value, 2);

  pages.get("alpha").resolve(payload("alpha"));
  const alphaTab = await alpha;
  assert.equal(session.pendingTableOpenCount.value, 1);
  assert.equal(workspace.activeTabId, current.id);

  pages.get("beta").resolve(payload("beta"));
  const betaTab = await beta;
  assert.equal(session.pendingTableOpenCount.value, 0);
  assert.notEqual(alphaTab.id, betaTab.id);
  assert.equal(workspace.activeTabId, betaTab.id);
});

test("explicit tab selection cancels a pending table activation", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game" });
  const current = openTableTab(workspace, { tableName: "current" }, { activate: true });
  current.sessionId = "current-session";
  const page = deferred();
  const invoke = async (command) => {
    if (command === "open_table_session") return page.promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const opening = session.openTable({ tableName: "player" });
  session.cancelPendingTableActivation(workspace.focusedPaneId);
  page.resolve({
    sessionId: "player-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });
  await opening;

  assert.equal(workspace.activeTabId, current.id);
});

test("database navigation prevents an older table open from stealing focus", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "mysql-1", database: "old_db" }));
  openDatabaseHomeTab(workspace, {
    connectionId: "mysql-1",
    database: "old_db",
  }, { activate: true });
  const page = deferred();
  const invoke = async (command) => {
    if (command === "open_table_session") return page.promise;
    if (command === "close_table_session") return { closed: true };
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { statusText: ref("") });

  const opening = session.openTable({
    connectionId: "mysql-1",
    database: "old_db",
    tableName: "orders",
  });
  workspace.database = "new_db";
  const newHome = openDatabaseHomeTab(workspace, {
    connectionId: "mysql-1",
    database: "new_db",
  }, { activate: true });
  page.resolve({
    sessionId: "orders-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 1,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1000,
  });

  const loaded = await opening;

  assert.equal(workspace.activeTabId, newHome.id);
  assert.equal(loaded.database, "old_db");
  assert.equal(loaded.opening, false);
  assert.deepEqual(loaded.rows, [{ id: 1 }]);
});

test("opening a table can load it in the background without changing the active tab", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const first = {
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "items",
    tableKey: "mysql-1\u001fgame\u001fitems",
    sessionId: "items-session",
    page: 1,
    pageSize: 1000,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 1,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  };
  workspace.tabs = [first];
  workspace.activeTabId = first.id;
  workspace.nextTabSeq = 2;
  const invoke = async (command) => {
    if (command === "get_table_schema") return { table_name: "quests", columns: [{ column_name: "quest_id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: "quests-session",
        columns: [{ column_name: "quest_id" }],
        rows: [{ quest_id: 7 }],
        totalRows: 1,
        page: 1,
        pageSize: 1000,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.openTable({ table_name: "quests" }, { activate: false });

  assert.equal(workspace.activeTabId, first.id);
  assert.equal(workspace.tabs[1].sessionId, "quests-session");
  assert.deepEqual(workspace.tabs[1].rows, [{ quest_id: 7 }]);
});

test("opening a table reuses an existing tab across panes and jumps to it", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  workspace.layout = {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "pane", paneId: "pane-1" },
    second: { type: "pane", paneId: "pane-2" },
  };
  const invoke = async (command, payload) => {
    if (command === "get_table_schema") return { table_name: payload.tableName, columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: `${payload.tableName}-${workspace.tabs.length}`,
        columns: [{ column_name: "id" }],
        rows: [{ id: workspace.tabs.length }],
        totalRows: 1,
        page: 1,
        pageSize: 1000,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const left = await session.openTable({ table_name: "hero" }, { paneId: "pane-1" });
  // 同一表在 pane-2 再开：跨 pane 复用 pane-1 已有 tab，不新建重复 tab，
  // 并把焦点切到该 tab 所在 pane。
  const reused = await session.openTable({ table_name: "hero" }, { paneId: "pane-2" });

  assert.equal(reused.id, left.id);
  assert.deepEqual(workspace.panes["pane-1"].tabIds, [left.id]);
  assert.deepEqual(workspace.panes["pane-2"].tabIds, []);
  assert.equal(workspace.focusedPaneId, "pane-1");
  assert.equal(workspace.activeTabId, left.id);
  assert.equal(workspace.tabs.length, 1);
});

test("openTable with duplicate=true bypasses cross-pane reuse and opens a fresh tab", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  workspace.layout = {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "pane", paneId: "pane-1" },
    second: { type: "pane", paneId: "pane-2" },
  };
  const invoke = async (command, payload) => {
    if (command === "get_table_schema") return { table_name: payload.tableName, columns: [{ column_name: "id" }] };
    if (command === "open_table_session") {
      return {
        sessionId: `${payload.tableName}-${workspace.tabs.length}`,
        columns: [{ column_name: "id" }],
        rows: [{ id: workspace.tabs.length }],
        totalRows: 1,
        page: 1,
        pageSize: 1000,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  const left = await session.openTable({ table_name: "hero" }, { paneId: "pane-1" });
  // duplicate=true 强制在目标 pane 新建，即便别处已打开同表
  const right = await session.openTable({ table_name: "hero" }, { paneId: "pane-2", duplicate: true });

  assert.notEqual(left.id, right.id);
  assert.deepEqual(workspace.panes["pane-1"].tabIds, [left.id]);
  assert.deepEqual(workspace.panes["pane-2"].tabIds, [right.id]);
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
  const thirdResult = await thirdPage;
  pages.get(2).resolve({ sessionId: "hero-session", columns: [], rows: [{ id: 2 }], totalRows: 3, page: 2, pageSize: 1000 });
  const secondResult = await secondPage;

  assert.deepEqual(thirdResult, { ok: true, tab });
  assert.deepEqual(secondResult, { ok: false, stale: true });
  assert.equal(tab.page, 3);
  assert.deepEqual(tab.rows, [{ id: 3 }]);
});

test("a stale rejected page request reports stale instead of a real error", async () => {
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
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const pages = new Map([
    [2, deferred()],
    [3, deferred()],
  ]);
  const statusText = ref("");
  const invoke = async (command, payload) => {
    if (command !== "fetch_table_page") throw new Error(`unexpected command ${command}`);
    return pages.get(payload.request.page).promise;
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText });
  const tab = workspace.tabs[0];

  const staleRequest = session.fetchPage(tab, 2);
  const currentRequest = session.fetchPage(tab, 3);
  pages.get(3).resolve({ sessionId: "hero-session", columns: [{ column_name: "id" }], rows: [{ id: 3 }], totalRows: 3, page: 3, pageSize: 1000 });
  const currentResult = await currentRequest;
  pages.get(2).reject(new Error("old session closed"));
  const staleResult = await staleRequest;

  assert.deepEqual(currentResult, { ok: true, tab });
  assert.deepEqual(staleResult, { ok: false, stale: true });
  assert.equal(tab.page, 3);
  assert.deepEqual(tab.rows, [{ id: 3 }]);
  assert.equal(statusText.value, "game.hero：3 行");
});

test("fetchPage reports success and backend failure to callers", async () => {
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
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const statusText = ref("");
  const failures = new Set([3]);
  const invoke = async (command, payload) => {
    if (command !== "fetch_table_page") throw new Error(`unexpected command ${command}`);
    if (failures.has(payload.request.page)) throw new Error("backend unavailable");
    return {
      sessionId: "hero-session",
      columns: [{ column_name: "id" }],
      rows: [{ id: payload.request.page }],
      totalRows: 3,
      page: payload.request.page,
      pageSize: 1000,
    };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText });
  const tab = workspace.tabs[0];

  const success = await session.fetchPage(tab, 2);
  const failure = await session.fetchPage(tab, 3);

  assert.deepEqual(success, { ok: true, tab });
  assert.equal(failure?.ok, false);
  assert.match(String(failure?.error), /backend unavailable/);
  assert.deepEqual(tab.rows, [{ id: 2 }]);
  assert.equal(tab.loading, false);
  assert.match(statusText.value, /读取分页失败：backend unavailable/);
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
  assert.equal(calls[0].payload.request.includeTotal, false);
  assert.equal(workspace.tabs[0].rows.length, REQUEST_PAGE_SIZE + 1);
  assert.deepEqual(workspace.tabs[0].rows.at(-1), { id: REQUEST_PAGE_SIZE + 1 });
});

test("loadNextPage derives the next page from the loaded offset instead of the previous page size", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 2,
    pageSize: 500,
    rows: Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 })),
    columns: [{ column_name: "id" }],
    totalRows: 1000,
    totalRowsExact: false,
    hasMore: true,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {
      sessionId: "hero-session",
      rows: [{ id: 1001 }],
      totalRows: 1001,
      totalRowsExact: false,
      hasMore: true,
      page: 3,
      pageSize: 500,
    };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.loadNextPage(workspace.tabs[0]);

  assert.equal(calls[0].payload.request.page, 2);
  assert.equal(calls[0].payload.request.pageSize, REQUEST_PAGE_SIZE);
  assert.equal(calls[0].payload.request.offset, 1000);
  assert.equal(calls[0].payload.request.includeTotal, false);
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
  assert.equal(calls[0].payload.request.offset, 1);
});

test("loadNextPage fills the first 1000-row buffer from offset 100 before using 1000-row chunks", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    rows: Array.from({ length: DEFAULT_PAGE_SIZE }, (_, index) => ({ id: index + 1 })),
    columns: [{ column_name: "id" }],
    totalRows: DEFAULT_PAGE_SIZE,
    totalRowsExact: false,
    hasMore: true,
    filter: "",
    sort: { columnName: "id", descending: false },
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
  }];
  const calls = [];
  const invoke = async (_command, payload) => {
    calls.push(payload.request);
    const { offset, pageSize, page } = payload.request;
    return {
      sessionId: "hero-session",
      rows: Array.from({ length: pageSize }, (_, index) => ({ id: offset + index + 1 })),
      totalRows: offset + pageSize,
      totalRowsExact: false,
      hasMore: true,
      page,
      pageSize,
    };
  };
  const session = useTableSession(workspace, invoke, { statusText: ref("") });
  const tab = workspace.tabs[0];

  await session.loadNextPage(tab);
  await session.loadNextPage(tab);

  assert.deepEqual(calls.map(({ page, pageSize, offset, sort }) => ({ page, pageSize, offset, sort })), [
    { page: 1, pageSize: 900, offset: 100, sort: { columnName: "id", descending: false } },
    { page: 2, pageSize: 1000, offset: 1000, sort: { columnName: "id", descending: false } },
  ]);
  assert.equal(tab.rows.length, 2000);
  assert.deepEqual(tab.rows.map((row) => row.id), Array.from({ length: 2000 }, (_, index) => index + 1));
});

test("applySort sends an explicit ascending sort request for the first page", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 2,
    pageSize: 1000,
    rows: [{ id: 2 }],
    columns: [{ column_name: "name" }],
    totalRows: 2,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ name: "Alice" }], totalRows: 1, page: 1, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  await session.applySort(tab, "name", "ascending");

  assert.deepEqual(tab.sort, { columnName: "name", descending: false });
  assert.equal(calls[0].payload.request.page, 1);
  assert.deepEqual(calls[0].payload.request.sort, { columnName: "name", descending: false });
});

test("applySort sends descending sort and can remove sorting", async () => {
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
    columns: [{ column_name: "name" }],
    totalRows: 1,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ name: "Bob" }], totalRows: 1, page: 1, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  await session.applySort(tab, "name", "descending");
  await session.applySort(tab, "name", "none");

  assert.deepEqual(calls[0].payload.request.sort, { columnName: "name", descending: true });
  assert.equal(calls[1].payload.request.sort, null);
  assert.equal(tab.sort, null);
});

test("isSessionInvalidError recognizes backend dead-session messages", () => {
  assert.ok(isSessionInvalidError(new Error("表会话已失效，请重新打开表")));
  assert.ok(isSessionInvalidError("表会话的数据库连接已失效，请重新打开表"));
  assert.ok(isSessionInvalidError(new Error("连接资源已关闭，请重新连接")));
  assert.ok(!isSessionInvalidError(new Error("网络超时")));
  assert.ok(!isSessionInvalidError(null));
});

function deadSessionTab(overrides = {}) {
  return {
    id: "tab-1",
    kind: "data",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "dead-session",
    page: 1,
    pageSize: 1000,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 1,
    filter: "",
    sort: null,
    loading: false,
    loadingMore: false,
    ...overrides,
  };
}

test("fetchPage reopens the session transparently when the backend session died", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [deadSessionTab({ sort: { columnName: "id", descending: true } })];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "fetch_table_page") throw new Error("表会话已失效，请重新打开表");
    if (command === "open_table_session") {
      return {
        sessionId: "fresh-session",
        columns: [{ column_name: "id" }],
        rows: [{ id: 9 }],
        totalRows: 1,
        totalRowsExact: true,
        hasMore: false,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      };
    }
    return { closed: true };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const result = await session.fetchPage(tab, 1);

  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.deepEqual(calls.map((call) => call.command), ["fetch_table_page", "open_table_session"]);
  const openCall = calls.find((call) => call.command === "open_table_session");
  assert.equal(openCall.payload.connectionId, "mysql-1");
  assert.equal(openCall.payload.database, "game");
  assert.equal(openCall.payload.tableName, "hero");
  assert.deepEqual(openCall.payload.options.sort, { columnName: "id", descending: true });
  assert.equal(tab.sessionId, "fresh-session");
  assert.equal(tab.loadError, null);
});

test("fetchPage surfaces the error when session recovery also fails", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [deadSessionTab()];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "fetch_table_page") throw new Error("表会话已失效，请重新打开表");
    if (command === "open_table_session") throw new Error("连接资源已关闭，请重新连接");
    return { closed: true };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const result = await session.fetchPage(tab, 1);

  assert.equal(result.ok, false);
  assert.equal(
    calls.filter((call) => call.command === "open_table_session").length,
    1,
    "recovery must not retry in a loop",
  );
  assert.equal(tab.sessionId, "");
  assert.match(String(tab.loadError), /连接资源已关闭/);
});

test("handleSessionsInvalidated reopens only the listed sessions", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [
    deadSessionTab({ id: "tab-a", tableName: "hero", sessionId: "s-1" }),
    deadSessionTab({ id: "tab-b", tableName: "item", sessionId: "s-2" }),
    deadSessionTab({ id: "tab-c", tableName: "pet", sessionId: "s-3", connectionId: "mysql-2" }),
  ];
  workspace.activeTabId = "tab-b";
  const opened = [];
  const invoke = async (command, payload) => {
    if (command === "open_table_session") {
      opened.push(payload.tableName);
      return {
        sessionId: `fresh-${payload.tableName}`,
        columns: [{ column_name: "id" }],
        rows: [],
        totalRows: 0,
        totalRowsExact: true,
        hasMore: false,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      };
    }
    return { closed: true };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.handleSessionsInvalidated({
    connectionId: "mysql-1",
    sessionIds: ["s-2"],
    reason: "expired",
  });

  assert.deepEqual(opened, ["item"]);
  assert.equal(workspace.tabs[0].sessionId, "s-1");
  assert.equal(workspace.tabs[1].sessionId, "fresh-item");
  assert.equal(workspace.tabs[2].sessionId, "s-3");
});

test("handleSessionsInvalidated matches by connection when no session ids are given", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [
    deadSessionTab({ id: "tab-a", tableName: "hero", sessionId: "s-1" }),
    deadSessionTab({ id: "tab-c", tableName: "pet", sessionId: "s-3", connectionId: "mysql-2" }),
  ];
  workspace.activeTabId = "tab-a";
  const opened = [];
  const invoke = async (command, payload) => {
    if (command === "open_table_session") {
      opened.push(payload.tableName);
      return {
        sessionId: `fresh-${payload.tableName}`,
        columns: [{ column_name: "id" }],
        rows: [],
        totalRows: 0,
        totalRowsExact: true,
        hasMore: false,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      };
    }
    return { closed: true };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.handleSessionsInvalidated({
    connectionId: "mysql-1",
    sessionIds: [],
    reason: "connection-removed",
  });

  assert.deepEqual(opened, ["hero"]);
  assert.equal(workspace.tabs[0].sessionId, "fresh-hero");
  assert.equal(workspace.tabs[1].sessionId, "s-3");
});

test("jumpToTableBoundary fetches only the exact count and final window", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
    totalRows: 100,
    totalRowsExact: false,
    hasMore: true,
    page: 1,
    pageSize: 100,
  });
  tab.sort = { columnName: "id", descending: true };
  tab.hitResultMode = true;
  tab.filter = "boss";
  const calls = [];
  const session = useTableSession(workspace, async (command, payload) => {
    calls.push({ command, payload });
    if (command === "fetch_table_count") return { totalRows: 2505, exact: true };
    if (command === "fetch_table_page") {
      return {
        sessionId: "hero-session",
        columns: [{ column_name: "id" }],
        rows: Array.from({ length: 505 }, (_, index) => ({ id: 2001 + index })),
        totalRows: 1000,
        totalRowsExact: false,
        hasMore: true,
        page: 3,
        pageSize: 1000,
      };
    }
    if (command === "cancel_table_count") return { cancelled: true };
    throw new Error(`unexpected command ${command}`);
  }, { statusText: ref("") });

  const result = await session.jumpToTableBoundary(tab, "bottom");

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.command), ["fetch_table_count", "fetch_table_page"]);
  assert.deepEqual(calls[0].payload.filter, { query: "boss", columns: [], mode: "continuous" });
  assert.equal(calls[1].payload.request.offset, 2000);
  assert.equal(calls[1].payload.request.pageSize, REQUEST_PAGE_SIZE);
  assert.deepEqual(calls[1].payload.request.filter, { query: "boss", columns: [], mode: "continuous" });
  assert.deepEqual(calls[1].payload.request.sort, { columnName: "id", descending: true });
  assert.equal(tab.rowWindowOffset, 2000);
  assert.equal(tab.totalRows, 2505);
  assert.equal(tab.fullyLoaded, true);
  assert.equal(tab.rows.at(-1).id, 2505);
});

test("jumpToTableBoundary returns to the first window without recounting", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 2505 }],
    totalRows: 2505,
    totalRowsExact: true,
    hasMore: false,
    page: 3,
    pageSize: 1000,
    rowWindowOffset: 1505,
  });
  const calls = [];
  const session = useTableSession(workspace, async (command, payload) => {
    calls.push({ command, payload });
    assert.equal(command, "fetch_table_page");
    return {
      sessionId: "hero-session",
      columns: [{ column_name: "id" }],
      rows: [{ id: 1 }, { id: 2 }],
      totalRows: 2,
      totalRowsExact: false,
      hasMore: true,
      page: 1,
      pageSize: 1000,
    };
  }, { statusText: ref("") });

  const result = await session.jumpToTableBoundary(tab, "top");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.request.offset, 0);
  assert.equal(tab.rowWindowOffset, 0);
  assert.equal(tab.totalRows, 2505);
  assert.equal(tab.totalRowsExact, true);
  assert.deepEqual(tab.rows, [{ id: 1 }, { id: 2 }]);
});

test("jumpToTableBoundary aligns an exact full final page without recounting", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 2000,
    totalRowsExact: true,
    hasMore: true,
    page: 1,
    pageSize: 1000,
  });
  const calls = [];
  const session = useTableSession(workspace, async (command, payload) => {
    calls.push({ command, payload });
    assert.equal(command, "fetch_table_page");
    return {
      sessionId: "hero-session",
      columns: [{ column_name: "id" }],
      rows: Array.from({ length: 1000 }, (_, index) => ({ id: 1001 + index })),
      totalRows: 2000,
      totalRowsExact: true,
      hasMore: false,
      page: 2,
      pageSize: 1000,
    };
  }, { statusText: ref("") });

  const result = await session.jumpToTableBoundary(tab, "bottom");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.request.page, 2);
  assert.equal(calls[0].payload.request.offset, 1000);
  assert.equal(tab.rowWindowOffset, 1000);
  assert.equal(tab.rows.at(-1).id, 2000);
});

test("jumpToTableBoundary keeps an empty table on the first window", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "empty_table" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "empty-session",
    columns: [{ column_name: "id" }],
    rows: [],
    totalRows: 0,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 100,
  });
  const session = useTableSession(workspace, async (command, payload) => {
    assert.equal(command, "fetch_table_page");
    assert.equal(payload.request.page, 1);
    assert.equal(payload.request.offset, 0);
    return {
      sessionId: "empty-session",
      columns: [{ column_name: "id" }],
      rows: [],
      totalRows: 0,
      totalRowsExact: true,
      hasMore: false,
      page: 1,
      pageSize: 1000,
    };
  }, { statusText: ref("") });

  const result = await session.jumpToTableBoundary(tab, "bottom");

  assert.equal(result.ok, true);
  assert.equal(tab.rowWindowOffset, 0);
  assert.deepEqual(tab.rows, []);
});

test("jumpToTableBoundary preserves the current window when the final page fails", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }, { id: 2 }],
    totalRows: 2,
    totalRowsExact: false,
    hasMore: true,
    page: 1,
    pageSize: 100,
  });
  tab.selectedRowKeys.add("id=1");
  const session = useTableSession(workspace, async (command) => {
    if (command === "fetch_table_count") return { totalRows: 2505, exact: true };
    if (command === "fetch_table_page") throw new Error("network down");
    throw new Error(`unexpected command ${command}`);
  }, { statusText: ref("") });

  const result = await session.jumpToTableBoundary(tab, "bottom");

  assert.equal(result.ok, false);
  assert.deepEqual(tab.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(tab.rowWindowOffset, 0);
  assert.equal(tab.selectedRowKeys.has("id=1"), true);
  assert.match(tab.loadMoreError, /network down/);
});

test("loadPreviousPage fetches the previous window and prepends it", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: Array.from({ length: 505 }, (_, index) => ({ id: 2001 + index })),
    totalRows: 2505,
    totalRowsExact: true,
    hasMore: false,
    page: 3,
    pageSize: 1000,
    rowWindowOffset: 2000,
  });
  tab.sort = { columnName: "id", descending: true };
  tab.hitResultMode = true;
  tab.filter = "boss";
  const calls = [];
  const session = useTableSession(workspace, async (command, payload) => {
    calls.push({ command, payload });
    assert.equal(command, "fetch_table_page");
    return {
      sessionId: "hero-session",
      columns: [{ column_name: "id" }],
      rows: Array.from({ length: 1000 }, (_, index) => ({ id: 1001 + index })),
      totalRows: 2505,
      totalRowsExact: true,
      hasMore: true,
      page: 2,
      pageSize: 1000,
    };
  }, { statusText: ref("") });

  const result = await session.loadPreviousPage(tab);

  assert.equal(result.ok, true);
  assert.equal(result.addedRows, 1000);
  assert.equal(result.offset, 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.request.offset, 1000);
  assert.equal(calls[0].payload.request.pageSize, REQUEST_PAGE_SIZE);
  assert.equal(calls[0].payload.request.page, 2);
  assert.deepEqual(calls[0].payload.request.filter, { query: "boss", columns: [], mode: "continuous" });
  assert.deepEqual(calls[0].payload.request.sort, { columnName: "id", descending: true });
  assert.equal(tab.rowWindowOffset, 1000);
  assert.equal(tab.rows.length, 1505);
  assert.equal(tab.rows[0].id, 1001);
  assert.equal(tab.rows[1000].id, 2001);
  assert.equal(tab.totalRows, 2505);
  assert.equal(tab.hasMore, false);
  assert.equal(tab.loadingPrevious, false);
});

test("loadPreviousPage clamps to the first window when less than a full page remains", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 501 }, { id: 502 }],
    totalRows: 1502,
    totalRowsExact: true,
    hasMore: false,
    page: 2,
    pageSize: 1000,
    rowWindowOffset: 500,
  });
  const calls = [];
  const session = useTableSession(workspace, async (command, payload) => {
    calls.push({ command, payload });
    return {
      sessionId: "hero-session",
      columns: [{ column_name: "id" }],
      rows: Array.from({ length: 500 }, (_, index) => ({ id: index + 1 })),
      totalRows: 1502,
      totalRowsExact: true,
      hasMore: true,
      page: 1,
      pageSize: 500,
    };
  }, { statusText: ref("") });

  const result = await session.loadPreviousPage(tab);

  assert.equal(result.ok, true);
  assert.equal(result.addedRows, 500);
  assert.equal(calls[0].payload.request.offset, 0);
  assert.equal(calls[0].payload.request.pageSize, 500);
  assert.equal(calls[0].payload.request.page, 1);
  assert.equal(tab.rowWindowOffset, 0);
  assert.equal(tab.rows.length, 502);
  assert.equal(tab.rows[500].id, 501);
});

test("loadPreviousPage refuses at the top of the table without invoking the backend", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 2505,
    totalRowsExact: true,
    hasMore: true,
    page: 1,
    pageSize: 1000,
    rowWindowOffset: 0,
  });
  let invoked = 0;
  const session = useTableSession(workspace, async () => {
    invoked += 1;
    throw new Error("should not be called");
  }, { statusText: ref("") });

  const result = await session.loadPreviousPage(tab);

  assert.equal(result.ok, false);
  assert.equal(result.atTop, true);
  assert.equal(invoked, 0);
});

test("loadPreviousPage skips search mode, busy tabs and visible insert drafts", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 2001 }],
    totalRows: 2505,
    totalRowsExact: true,
    hasMore: false,
    page: 3,
    pageSize: 1000,
    rowWindowOffset: 2000,
  });
  let invoked = 0;
  const session = useTableSession(workspace, async () => {
    invoked += 1;
    throw new Error("should not be called");
  }, { statusText: ref("") });

  tab.searchResultMode = true;
  assert.equal((await session.loadPreviousPage(tab)).ok, false);
  tab.searchResultMode = false;

  tab.loadingMore = true;
  assert.equal((await session.loadPreviousPage(tab)).busy, true);
  tab.loadingMore = false;

  tab.insertDrafts = [{ id: "draft-1", draft: { id: 1 }, visible: true }];
  const draftResult = await session.loadPreviousPage(tab);
  assert.equal(draftResult.ok, false);
  assert.equal(draftResult.insertDrafts, true);
  tab.insertDrafts = [];

  assert.equal(invoked, 0);
});

test("loadPreviousPage surfaces failures without moving the window", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" });
  replaceTabPage(workspace, tab.id, {
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 2001 }],
    totalRows: 2505,
    totalRowsExact: true,
    hasMore: false,
    page: 3,
    pageSize: 1000,
    rowWindowOffset: 2000,
  });
  const session = useTableSession(workspace, async () => {
    throw new Error("network down");
  }, { statusText: ref("") });

  const result = await session.loadPreviousPage(tab);

  assert.equal(result.ok, false);
  assert.equal(tab.rowWindowOffset, 2000);
  assert.deepEqual(tab.rows, [{ id: 2001 }]);
  assert.equal(tab.loadingPrevious, false);
  assert.match(tab.loadMoreError, /network down/);
});

function freshPageInvoke(opened, calls = []) {
  return async (command, payload) => {
    calls.push({ command, payload });
    if (command === "open_table_session") {
      opened.push(payload.tableName);
      return {
        sessionId: `fresh-${payload.tableName}`,
        columns: [{ column_name: "id" }],
        rows: [{ id: 1 }],
        totalRows: 1,
        totalRowsExact: true,
        hasMore: false,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      };
    }
    return { closed: true };
  };
}

test("expired sessions reload only on-screen tabs and defer background tabs until shown", async () => {
  const workspace = reactive(createWorkspaceState({ connectionId: "mysql-1", database: "game" }));
  workspace.tabs = [
    deadSessionTab({ id: "tab-a", tableName: "hero", sessionId: "s-1" }),
    deadSessionTab({ id: "tab-b", tableName: "item", sessionId: "s-2" }),
  ];
  workspace.panes["pane-1"].tabIds = ["tab-a", "tab-b"];
  workspace.panes["pane-1"].activeTabId = "tab-a";
  workspace.activeTabId = "tab-a";
  const opened = [];
  const session = useTableSession(workspace, freshPageInvoke(opened), { busy: ref(false), statusText: ref("") });

  await session.handleSessionsInvalidated({ connectionId: "mysql-1", sessionIds: ["s-1", "s-2"], reason: "expired" });

  assert.deepEqual(opened, ["hero"]);
  assert.equal(workspace.tabs[1].sessionId, "");
  assert.equal(workspace.tabs[1].deferredLoad, true);
  assert.equal(workspace.tabs[1].rows.length, 1, "deferred tabs keep their last rows until shown");

  workspace.panes["pane-1"].activeTabId = "tab-b";
  workspace.activeTabId = "tab-b";
  await nextTick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opened, ["hero", "item"]);
  assert.equal(workspace.tabs[1].sessionId, "fresh-item");
  assert.equal(workspace.tabs[1].deferredLoad, false);
});

test("a deferred tab loads once with its restored sort when opened or paged", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: "hero" }, { activate: false });
  tab.sort = { columnName: "id", descending: true };
  tab.deferredLoad = true;
  const opened = [];
  const calls = [];
  const session = useTableSession(workspace, freshPageInvoke(opened, calls), { busy: ref(false), statusText: ref("") });

  const [viaOpen, viaFetch] = await Promise.all([
    session.openTable({ tableName: "hero", connectionId: "mysql-1", database: "game" }),
    session.fetchPage(tab, 1),
  ]);

  assert.deepEqual(opened, ["hero"], "concurrent callers share one first-page load");
  assert.equal(viaOpen.id, tab.id);
  assert.equal(viaFetch.ok, true);
  const openCall = calls.find((call) => call.command === "open_table_session");
  assert.deepEqual(openCall.payload.options.sort, { columnName: "id", descending: true });
  assert.deepEqual(workspace.tabs[0].sort, { columnName: "id", descending: true });
});

test("background preload loads deferred tabs one at a time", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  for (const name of ["hero", "item", "pet"]) {
    const tab = openTableTab(workspace, { connectionId: "mysql-1", database: "game", tableName: name }, { activate: false });
    tab.deferredLoad = true;
  }
  let inFlight = 0;
  let maxInFlight = 0;
  const opened = [];
  const base = freshPageInvoke(opened);
  const invoke = async (command, payload) => {
    if (command !== "open_table_session") return base(command, payload);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return base(command, payload);
  };
  const statusText = ref("ready");
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText });

  const preload = session.preloadDeferredTabs();
  assert.equal(session.pendingTableOpenCount.value, 0, "background preload shows no progress cursor");
  await preload;

  assert.deepEqual(opened, ["hero", "item", "pet"]);
  assert.equal(maxInFlight, 1);
  assert.equal(statusText.value, "ready", "background preload leaves the status bar alone");
  assert.ok(workspace.tabs.every((tab) => tab.sessionId && !tab.deferredLoad));
});

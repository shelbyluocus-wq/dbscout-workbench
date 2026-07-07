import test from "node:test";
import assert from "node:assert/strict";
import { nextTick, reactive, ref, watch } from "vue";

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
  // allow the background get_table_schema (fire-and-forget) to flush
  await Promise.resolve();

  // open_table_session is now the blocking call; get_table_schema runs in the
  // background to refresh the sidebar tree, so their relative order is not part
  // of the contract anymore.
  const schemaCall = calls.find((c) => c.command === "get_table_schema");
  const sessionCall = calls.find((c) => c.command === "open_table_session");
  assert.deepEqual(schemaCall, {
    command: "get_table_schema",
    payload: { connectionId: "mysql-stage", database: "stage_game", tableName: "hero" },
  });
  assert.deepEqual(sessionCall, {
    command: "open_table_session",
    payload: {
      connectionId: "mysql-stage",
      database: "stage_game",
      tableName: "hero",
      options: { page: 1, pageSize: 1000, includeTotal: false },
    },
  });
  assert.equal(workspace.tabs[0].connectionId, "mysql-stage");
  assert.equal(workspace.tabs[0].database, "stage_game");
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
    pageSize: REQUEST_PAGE_SIZE,
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
    if (command === "fetch_table_page") {
      return {
        sessionId: "hero-hit-session",
        rows: [{ id: 1 }],
        totalRows: 42,
        totalRowsExact: true,
        hasMore: false,
        page: 1,
        pageSize: 1,
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
  const countCall = calls.find((call) => call.command === "fetch_table_page");
  assert.deepEqual(openCall.payload.options.filter, {
    query: "needle",
    columns: [],
    mode: "exact",
  });
  assert.deepEqual(countCall.payload.request.filter, {
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

test("loadSearchResultPage fetches the first backend-filtered page without exact totals", async () => {
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
      columns: [{ column_name: "id" }, { column_name: "note" }],
      rows: [{ id: 9001, note: "needle" }],
      totalRows: 1,
      totalRowsExact: false,
      hasMore: false,
      page: 1,
      pageSize: REQUEST_PAGE_SIZE,
    };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const loaded = await session.loadSearchResultPage(tab, "needle");

  assert.equal(loaded, true);
  assert.equal(calls[0].command, "fetch_table_page");
  assert.deepEqual(calls[0].payload.request, {
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    includeTotal: false,
    filter: { query: "needle", columns: [], mode: "exact" },
    sort: null,
  });
  assert.deepEqual(tab.rows, [{ id: 9001, note: "needle" }]);
  assert.equal(tab.searchResultMode, true);
  assert.equal(tab.searchResultQuery, "needle");
  assert.equal(tab.hitResultMode, false);
});

test("clearing a search result page returns to the unfiltered first page", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    rows: [{ id: 9001, note: "needle" }],
    columns: [{ column_name: "id" }, { column_name: "note" }],
    totalRows: 1,
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
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {
      sessionId: "hero-session",
      columns: [{ column_name: "id" }, { column_name: "note" }],
      rows: [{ id: 1, note: "first page" }],
      totalRows: REQUEST_PAGE_SIZE,
      totalRowsExact: false,
      hasMore: true,
      page: 1,
      pageSize: REQUEST_PAGE_SIZE,
    };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });
  const tab = workspace.tabs[0];

  const loaded = await session.loadSearchResultPage(tab, "");

  assert.equal(loaded, true);
  assert.equal(calls[0].command, "fetch_table_page");
  assert.equal(calls[0].payload.request.filter, null);
  assert.equal(tab.searchResultMode, false);
  assert.equal(tab.searchResultQuery, "");
  assert.deepEqual(tab.rows, [{ id: 1, note: "first page" }]);
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

test("opening the current searched table reuses it without reloading", async () => {
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
    if (command === "fetch_table_page") {
      return {
        sessionId: "hero-session",
        rows: [{ id: 1 }],
        totalRows: 12345,
        totalRowsExact: true,
        hasMore: true,
        page: 1,
        pageSize: 1,
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

  const countCall = calls.find((call) => call.command === "fetch_table_page");
  assert.deepEqual(countCall.payload, {
    sessionId: "hero-session",
    request: {
      page: 1,
      pageSize: 1,
      includeTotal: true,
      filter: null,
      sort: null,
    },
  });
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
    if (command === "fetch_table_page") {
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
    sessionId: "hero-session",
    rows: [{ id: 1 }],
    totalRows: 999,
    totalRowsExact: true,
    hasMore: true,
    page: 1,
    pageSize: 1,
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
    if (command === "fetch_table_page") return failingCount.promise;
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

test("a replacement page cancels the pending background exact total", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const count = deferred();
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
    if (command === "fetch_table_page" && payload.request.includeTotal === true) {
      return count.promise;
    }
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
  await session.fetchPage(tab, 2);
  count.resolve({
    sessionId: "hero-session",
    rows: [{ id: 1 }],
    totalRows: 999,
    totalRowsExact: true,
    hasMore: false,
    page: 1,
    pageSize: 1,
  });
  await waitForTimers();

  assert.deepEqual(tab.rows, [{ id: 2 }]);
  assert.equal(tab.totalRows, 2);
  assert.equal(tab.totalRowsExact, false);
  assert.equal(tab.hasMore, true);
  assert.equal(tab.totalRowsLoading, false);
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

test("loadNextPage derives the next page from the backend-returned page size", async () => {
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

  assert.equal(calls[0].payload.request.page, 3);
  assert.equal(calls[0].payload.request.pageSize, REQUEST_PAGE_SIZE);
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

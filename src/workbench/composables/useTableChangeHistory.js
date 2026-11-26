import { computed, reactive } from "vue";
import { invokeWorkbench as defaultInvokeWorkbench } from "../utils/tauriBridge.js";
import {
  EXTERNAL_ACTOR_FILTER,
  detectExternalNewerModification,
  findNewerExternalRevision,
  groupAuditRevisions,
  mergeTableAuditEntries,
  mergeTableExternalChanges,
  mergeTimelineRevisions,
} from "../utils/tableChangeHistory.js";
import {
  normalizeSnapshotColumns,
  reconstructRevisionFullTable,
  restoreNullCellsOnRows,
  searchFullTableComparisonRows,
} from "../utils/tableHistorySnapshot.js";

const AUDIT_PAGE_LIMIT = 200;
const LIVE_PAGE_SIZE = 500;
export const DEFAULT_MAX_LIVE_ROWS = 3000;

/**
 * Per-tab table change-history & synchronized full-table before/after diff state.
 * Loads local audit logs, central-server shared logs (cross-PC, omitting local
 * connectionId), and the live table snapshot in parallel, then reconstructs
 * exact Before/After full-table states via inverse replay.
 */
export function useTableChangeHistory({
  invokeWorkbench = defaultInvokeWorkbench,
  isLoggedIn = () => false,
  getSelfLabel = () => "我",
  maxLiveRows = DEFAULT_MAX_LIVE_ROWS,
} = {}) {
  const state = reactive({
    connectionId: "",
    database: "",
    tableName: "",
    tableComment: "",
    tableMeta: null,
    observedTableMeta: null,
    loading: false,
    loadingMore: false,
    liveLoading: false,
    error: "",
    liveError: "",
    sharedStatus: "idle", // "idle" | "loaded" | "logged-out" | "error"
    sharedError: "",
    localOffset: 0,
    sharedOffset: 0,
    localHasMore: false,
    sharedHasMore: false,
    rawLocal: [],
    rawShared: [],
    rawLocalExternal: [],
    rawSharedExternal: [],
    observedExternal: null,
    revisions: [],
    selectedRevisionId: "",
    actorFilter: "",
    displayScope: "full", // "full" (default) | "changed"
    searchQuery: "",
    activeChangeIndex: 0,
    activeMatchIndex: 0,
    liveColumns: [],
    livePrimaryKeys: [],
    liveRows: [],
    liveTruncated: false,
  });

  let loadGeneration = 0;

  const effectiveTableMeta = computed(() => state.observedTableMeta || state.tableMeta);

  const actors = computed(() => {
    const counts = new Map();
    let externalCount = 0;
    for (const rev of state.revisions) {
      if (rev.isExternal) {
        externalCount += 1;
        continue;
      }
      const name = String(rev.actor || "").trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const list = [...counts.entries()].map(([name, count]) => ({
      name,
      count,
      isExternal: false,
    }));
    if (externalCount > 0) {
      list.push({
        name: EXTERNAL_ACTOR_FILTER,
        count: externalCount,
        isExternal: true,
      });
    }
    return list;
  });

  const filteredRevisions = computed(() => {
    if (!state.actorFilter) return state.revisions;
    if (state.actorFilter === EXTERNAL_ACTOR_FILTER) {
      return state.revisions.filter((rev) => rev.isExternal);
    }
    return state.revisions.filter((rev) => !rev.isExternal && rev.actor === state.actorFilter);
  });

  const selectedRevision = computed(() => (
    filteredRevisions.value.find((rev) => rev.id === state.selectedRevisionId)
    || filteredRevisions.value[0]
    || null
  ));

  const selectedRevisionFullIndex = computed(() => {
    const rev = selectedRevision.value;
    if (!rev) return -1;
    return state.revisions.findIndex((item) => item.id === rev.id);
  });

  const snapshot = computed(() => {
    const targetIndex = selectedRevisionFullIndex.value;
    if (targetIndex < 0) {
      return {
        mode: "empty",
        reason: "empty",
        columns: state.liveColumns,
        primaryKeys: state.livePrimaryKeys,
        rows: [],
        changedRowIndices: [],
        totalRows: 0,
        changedCount: 0,
        partialReplayWarning: false,
        hasSynthesizedRows: false,
      };
    }
    if (selectedRevision.value?.isExternal) {
      return {
        mode: "external",
        reason: "external-change",
        columns: state.liveColumns,
        primaryKeys: state.livePrimaryKeys,
        rows: [],
        changedRowIndices: [],
        totalRows: 0,
        changedCount: 0,
        partialReplayWarning: false,
        hasSynthesizedRows: false,
      };
    }
    if (state.liveError || (!state.liveLoading && state.liveColumns.length === 0)) {
      return {
        mode: "field-diff",
        reason: state.liveError ? "live-load-failed" : "no-live-schema",
        columns: state.liveColumns,
        primaryKeys: state.livePrimaryKeys,
        rows: [],
        changedRowIndices: [],
        totalRows: 0,
        changedCount: 0,
        partialReplayWarning: false,
        hasSynthesizedRows: false,
      };
    }
    return reconstructRevisionFullTable({
      columns: state.liveColumns,
      primaryKeys: state.livePrimaryKeys,
      liveRows: state.liveRows,
      revisions: state.revisions,
      targetIndex,
    });
  });

  const displayRows = computed(() => {
    const snap = snapshot.value;
    if (snap.mode !== "full-table") return [];
    if (state.displayScope === "changed") {
      return snap.rows.filter((row) => row.status !== "unchanged");
    }
    return snap.rows;
  });

  const changedDisplayIndices = computed(() => {
    const indices = [];
    const list = displayRows.value;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].status !== "unchanged") indices.push(i);
    }
    return indices;
  });

  const searchResult = computed(() => (
    snapshot.value.mode === "full-table"
      ? searchFullTableComparisonRows(displayRows.value, snapshot.value.columns, state.searchQuery)
      : {
          query: String(state.searchQuery || "").trim().toLowerCase(),
          matches: [],
          matchedRowIds: new Set(),
          matchedCellKeys: new Set(),
          matchedHeaderCols: new Set(),
        }
  ));

  const activeSearchMatch = computed(() => {
    const matches = searchResult.value.matches;
    if (!matches.length) return null;
    const clamped = ((state.activeMatchIndex % matches.length) + matches.length) % matches.length;
    return matches[clamped] || null;
  });

  const columnComments = computed(() => {
    const map = new Map();
    for (const col of state.liveColumns) {
      if (col?.name && col?.comment) {
        map.set(col.name.toLowerCase(), col.comment);
      }
    }
    return map;
  });

  const externalNotice = computed(() => {
    const selected = selectedRevision.value;
    if (selected?.isExternal) return null;
    const newerExternal = findNewerExternalRevision(state.revisions, selectedRevisionFullIndex.value);
    if (newerExternal) {
      return {
        modifiedAt: newerExternal.ts,
        source: newerExternal.timeKind === "detected" ? "external" : "database",
        timeKind: newerExternal.timeKind,
      };
    }
    const auditOnly = state.revisions.filter((rev) => !rev.isExternal);
    return detectExternalNewerModification(effectiveTableMeta.value, auditOnly);
  });

  const hasMore = computed(() => state.localHasMore || state.sharedHasMore);

  function recomputeRevisions() {
    const merged = mergeTableAuditEntries({
      localEntries: state.rawLocal,
      sharedEntries: state.rawShared,
      selfLabel: getSelfLabel(),
    });
    const auditRevisions = groupAuditRevisions(merged);
    const localExternal = state.observedExternal
      ? [state.observedExternal, ...state.rawLocalExternal]
      : state.rawLocalExternal;
    const externalRevisions = mergeTableExternalChanges({
      localEntries: localExternal,
      sharedEntries: state.rawSharedExternal,
      tableMeta: effectiveTableMeta.value,
      auditRevisions,
    });
    state.revisions = mergeTimelineRevisions(auditRevisions, externalRevisions);
    if (
      state.selectedRevisionId
      && state.revisions.some((rev) => rev.id === state.selectedRevisionId)
    ) {
      return;
    }
    state.selectedRevisionId = state.revisions[0]?.id || "";
    state.activeChangeIndex = 0;
    state.activeMatchIndex = 0;
  }

  async function loadLiveSnapshot(connectionId, database, tableName, generation) {
    if (!connectionId || !database || !tableName) return;
    state.liveLoading = true;
    state.liveError = "";
    state.liveTruncated = false;

    let sessionId = "";
    try {
      const firstPage = await invokeWorkbench("open_table_session", {
        connectionId,
        database,
        tableName,
        options: {
          offset: 0,
          pageSize: LIVE_PAGE_SIZE,
          includeTotal: false,
        },
      });
      if (generation !== loadGeneration) {
        sessionId = String(firstPage?.sessionId || firstPage?.session_id || "");
        return;
      }
      if (!firstPage || typeof firstPage !== "object") {
        state.liveColumns = [];
        state.livePrimaryKeys = [];
        state.liveRows = [];
        return;
      }

      sessionId = String(firstPage.sessionId || firstPage.session_id || "");
      const rawPrimaryKeys = Array.isArray(firstPage.primaryKeys)
        ? firstPage.primaryKeys
        : Array.isArray(firstPage.primary_keys)
          ? firstPage.primary_keys
          : [];
      const columns = normalizeSnapshotColumns(firstPage.columns || [], rawPrimaryKeys);
      const primaryKeys = rawPrimaryKeys.length
        ? rawPrimaryKeys
        : columns.filter((col) => col.primaryKey).map((col) => col.name);
      const collected = restoreNullCellsOnRows(
        firstPage.rows || [],
        firstPage.nullCells || firstPage.null_cells || [],
      );
      let hasMoreRows = Boolean(firstPage.hasMore ?? firstPage.has_more);
      let offset = collected.length;

      while (hasMoreRows && sessionId && collected.length < maxLiveRows) {
        const nextPage = await invokeWorkbench("fetch_table_page", {
          sessionId,
          request: {
            offset,
            pageSize: Math.min(LIVE_PAGE_SIZE, maxLiveRows - collected.length),
            includeTotal: false,
          },
        });
        if (generation !== loadGeneration) return;
        const pageRows = restoreNullCellsOnRows(
          nextPage?.rows || [],
          nextPage?.nullCells || nextPage?.null_cells || [],
        );
        if (!pageRows.length) {
          hasMoreRows = false;
          break;
        }
        collected.push(...pageRows);
        offset += pageRows.length;
        hasMoreRows = Boolean(nextPage?.hasMore ?? nextPage?.has_more);
      }

      if (generation !== loadGeneration) return;
      state.liveColumns = columns;
      state.livePrimaryKeys = primaryKeys;
      state.liveRows = collected;
      state.liveTruncated = hasMoreRows && collected.length >= maxLiveRows;
    } catch (error) {
      if (generation !== loadGeneration) return;
      state.liveError = String(error?.message || error || "读取当前表数据失败");
      state.liveColumns = [];
      state.livePrimaryKeys = [];
      state.liveRows = [];
    } finally {
      if (sessionId) {
        invokeWorkbench("close_table_session", { sessionId }).catch(() => {});
      }
      if (generation === loadGeneration) {
        state.liveLoading = false;
      }
    }
  }

  async function fetchAuditBatch({ append = false, generation } = {}) {
    if (!state.tableName || !state.database) return;
    const activeGen = generation ?? (append ? loadGeneration : ++loadGeneration);
    if (append) {
      if (state.loading || state.loadingMore || !hasMore.value) return;
      state.loadingMore = true;
    } else {
      state.loading = true;
      state.error = "";
      state.sharedError = "";
      state.localOffset = 0;
      state.sharedOffset = 0;
      state.localHasMore = false;
      state.sharedHasMore = false;
      state.rawLocal = [];
      state.rawShared = [];
      state.rawLocalExternal = [];
      state.rawSharedExternal = [];
      state.observedExternal = null;
      state.revisions = [];
      state.selectedRevisionId = "";
      state.actorFilter = "";
      state.activeChangeIndex = 0;
      state.activeMatchIndex = 0;
    }

    const signedIn = Boolean(isLoggedIn());
    const shouldLoadLocal = !append || state.localHasMore;
    const shouldLoadShared = signedIn && (!append || state.sharedHasMore);

    const localPromise = shouldLoadLocal
      ? invokeWorkbench("list_audit_logs", {
          request: {
            connectionId: state.connectionId || undefined,
            database: state.database,
            tableName: state.tableName,
            limit: AUDIT_PAGE_LIMIT,
            offset: state.localOffset,
          },
        }).then((rows) => ({ ok: true, rows: Array.isArray(rows) ? rows : [] }))
          .catch((error) => ({ ok: false, error: String(error?.message || error || "读取本机记录失败") }))
      : Promise.resolve({ ok: true, rows: null });

    const sharedPromise = shouldLoadShared
      ? invokeWorkbench("list_shared_audit_logs", {
          request: {
            // Omit connectionId intentionally so teammates whose local
            // connection numbering differs still match this table.
            database: state.database,
            tableName: state.tableName,
            limit: AUDIT_PAGE_LIMIT,
            offset: state.sharedOffset,
          },
        }).then((rows) => ({ ok: true, rows: Array.isArray(rows) ? rows : [] }))
          .catch((error) => ({ ok: false, error: String(error?.message || error || "读取团队记录失败") }))
      : Promise.resolve({ ok: true, rows: null });

    const localExternalPromise = !append
      ? invokeWorkbench("list_table_external_changes", {
          request: {
            connectionId: state.connectionId || undefined,
            database: state.database,
            tableName: state.tableName,
            limit: 100,
            offset: 0,
          },
        }).then((rows) => (Array.isArray(rows) ? rows : []))
          .catch(() => [])
      : Promise.resolve(null);

    const sharedExternalPromise = !append && signedIn
      ? invokeWorkbench("list_shared_table_external_changes", {
          request: {
            connectionId: state.connectionId || undefined,
            database: state.database,
            tableName: state.tableName,
            limit: 100,
            offset: 0,
          },
        }).then((rows) => (Array.isArray(rows) ? rows : []))
          .catch(() => [])
      : Promise.resolve(null);

    const observeExternalPromise = !append && state.connectionId
      ? invokeWorkbench("observe_table_external_change", {
          request: {
            connectionId: state.connectionId,
            database: state.database,
            tableName: state.tableName,
          },
        }).then((res) => (res && typeof res === "object" && !Array.isArray(res) ? res : null))
          .catch(() => null)
      : Promise.resolve(null);

    const [
      localRes,
      sharedRes,
      localExternalRows,
      sharedExternalRows,
      observedRes,
    ] = await Promise.all([
      localPromise,
      sharedPromise,
      localExternalPromise,
      sharedExternalPromise,
      observeExternalPromise,
    ]);
    if (activeGen !== loadGeneration) return;

    if (localRes.ok && Array.isArray(localRes.rows)) {
      state.localOffset += localRes.rows.length;
      state.localHasMore = localRes.rows.length >= AUDIT_PAGE_LIMIT;
      state.rawLocal = append ? [...state.rawLocal, ...localRes.rows] : localRes.rows;
    }

    if (Array.isArray(localExternalRows)) {
      state.rawLocalExternal = localExternalRows;
    }
    if (Array.isArray(sharedExternalRows)) {
      state.rawSharedExternal = sharedExternalRows;
    }
    if (observedRes) {
      if (observedRes.tableMeta && typeof observedRes.tableMeta === "object") {
        state.observedTableMeta = observedRes.tableMeta;
      }
      if (observedRes.detectedEvent && typeof observedRes.detectedEvent === "object") {
        state.observedExternal = observedRes.detectedEvent;
      }
    }

    if (!signedIn) {
      state.sharedStatus = "logged-out";
      state.sharedHasMore = false;
    } else if (sharedRes.ok && Array.isArray(sharedRes.rows)) {
      state.sharedStatus = "loaded";
      state.sharedOffset += sharedRes.rows.length;
      state.sharedHasMore = sharedRes.rows.length >= AUDIT_PAGE_LIMIT;
      state.rawShared = append ? [...state.rawShared, ...sharedRes.rows] : sharedRes.rows;
    } else if (!sharedRes.ok) {
      state.sharedStatus = "error";
      state.sharedError = sharedRes.error || "";
      state.sharedHasMore = false;
    }

    if (!localRes.ok && (!signedIn || !sharedRes.ok)) {
      state.error = localRes.error || sharedRes.error || "读取修改历史失败";
    }

    recomputeRevisions();
    state.loading = false;
    state.loadingMore = false;
  }

  async function loadForTable({
    connectionId = "",
    database = "",
    tableName = "",
    tableComment = "",
    tableMeta = null,
  } = {}) {
    if (!tableName || !database) return;
    const generation = ++loadGeneration;
    state.connectionId = String(connectionId || "");
    state.database = String(database || "");
    state.tableName = String(tableName || "");
    state.tableComment = String(tableComment || "");
    state.tableMeta = tableMeta || null;
    state.observedTableMeta = null;
    state.displayScope = "full";
    state.searchQuery = "";
    state.activeChangeIndex = 0;
    state.activeMatchIndex = 0;
    await Promise.all([
      fetchAuditBatch({ append: false, generation }),
      loadLiveSnapshot(state.connectionId, state.database, state.tableName, generation),
    ]);
  }

  function dispose() {
    loadGeneration += 1;
    state.loading = false;
    state.loadingMore = false;
    state.liveLoading = false;
  }

  function selectRevision(revisionId) {
    state.selectedRevisionId = String(revisionId || "");
    state.activeChangeIndex = 0;
    state.activeMatchIndex = 0;
  }

  function setActorFilter(actor) {
    state.actorFilter = state.actorFilter === actor ? "" : String(actor || "");
    const visible = filteredRevisions.value;
    if (visible.length && !visible.some((rev) => rev.id === state.selectedRevisionId)) {
      state.selectedRevisionId = visible[0].id;
      state.activeChangeIndex = 0;
      state.activeMatchIndex = 0;
    }
  }

  function setDisplayScope(scope) {
    const next = scope === "changed" ? "changed" : "full";
    if (state.displayScope === next) return;
    state.displayScope = next;
    state.activeChangeIndex = 0;
    state.activeMatchIndex = 0;
  }

  function setSearchQuery(query) {
    state.searchQuery = String(query ?? "");
    state.activeMatchIndex = 0;
  }

  function stepChange(delta) {
    const total = changedDisplayIndices.value.length;
    if (!total) return -1;
    state.activeChangeIndex = ((state.activeChangeIndex + delta) % total + total) % total;
    return changedDisplayIndices.value[state.activeChangeIndex];
  }

  function stepSearchMatch(delta) {
    const total = searchResult.value.matches.length;
    if (!total) return null;
    state.activeMatchIndex = ((state.activeMatchIndex + delta) % total + total) % total;
    return searchResult.value.matches[state.activeMatchIndex];
  }

  async function refresh() {
    const generation = ++loadGeneration;
    await Promise.all([
      fetchAuditBatch({ append: false, generation }),
      loadLiveSnapshot(state.connectionId, state.database, state.tableName, generation),
    ]);
  }

  async function loadMore() {
    await fetchAuditBatch({ append: true, generation: loadGeneration });
  }

  function setTableMeta(tableMeta) {
    state.tableMeta = tableMeta || null;
    recomputeRevisions();
  }

  return {
    state,
    actors,
    filteredRevisions,
    selectedRevision,
    selectedRevisionFullIndex,
    snapshot,
    displayRows,
    changedDisplayIndices,
    searchResult,
    activeSearchMatch,
    columnComments,
    externalNotice,
    hasMore,
    loadForTable,
    setTableMeta,
    dispose,
    selectRevision,
    setActorFilter,
    setDisplayScope,
    setSearchQuery,
    stepChange,
    stepSearchMatch,
    refresh,
    loadMore,
  };
}

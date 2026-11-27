import { computed, reactive } from "vue";
import { invokeWorkbench as defaultInvokeWorkbench } from "../utils/tauriBridge.js";
import {
  EXTERNAL_ACTOR_FILTER,
  detectExternalNewerModification,
  findNewerExternalRevision,
  groupAuditRevisions,
  groupContinuousEditSessions,
  inspectStreamRevisionHorizon,
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

const AUDIT_PAGE_LIMIT = 2000;
const REVISIONS_PER_BATCH = 10;
const MAX_PAGES_PER_BATCH = 60;
const LIVE_PAGE_SIZE = 1000;
export const DEFAULT_MAX_LIVE_ROWS = 10000;

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
    hasHeldBackRevisions: false,
    rawLocal: [],
    rawShared: [],
    rawLocalExternal: [],
    rawSharedExternal: [],
    observedExternal: null,
    revisions: [],
    selectedRevisionId: "",
    expandedSessionIds: [],
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

  const displayRevisions = computed(() => groupContinuousEditSessions(state.revisions));

  const actors = computed(() => {
    const counts = new Map();
    let externalCount = 0;
    for (const rev of displayRevisions.value) {
      if (rev.isExternal) {
        externalCount += 1;
        continue;
      }
      const names = Array.isArray(rev.actorsList) && rev.actorsList.length
        ? rev.actorsList
        : (rev.actor ? [rev.actor] : []);
      for (const rawName of names) {
        const name = String(rawName || "").trim();
        if (!name) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
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
    if (!state.actorFilter) return displayRevisions.value;
    if (state.actorFilter === EXTERNAL_ACTOR_FILTER) {
      return displayRevisions.value.filter((rev) => rev.isExternal);
    }
    return displayRevisions.value.filter((rev) => {
      if (rev.isExternal) return false;
      if (rev.actor === state.actorFilter) return true;
      return Array.isArray(rev.actorsList) && rev.actorsList.includes(state.actorFilter);
    });
  });

  function findSelectionInList(list, targetId) {
    if (!targetId) return null;
    for (const item of list) {
      if (item.id === targetId) return item;
      if (item.isSession && Array.isArray(item.steps)) {
        const step = item.steps.find((s) => s.id === targetId);
        if (step) return step;
      }
    }
    return null;
  }

  const selectedRevision = computed(() => (
    findSelectionInList(filteredRevisions.value, state.selectedRevisionId)
    || filteredRevisions.value[0]
    || null
  ));

  const selectedRevisionRange = computed(() => {
    const rev = selectedRevision.value;
    if (!rev) return { startIndex: -1, endIndex: -1 };
    if (Number.isInteger(rev.rangeStartIndex) && Number.isInteger(rev.rangeEndIndex)) {
      return { startIndex: rev.rangeStartIndex, endIndex: rev.rangeEndIndex };
    }
    const idx = state.revisions.findIndex((item) => item.id === rev.id);
    return { startIndex: idx, endIndex: idx };
  });

  const selectedRevisionFullIndex = computed(() => selectedRevisionRange.value.startIndex);

  const snapshot = computed(() => {
    const range = selectedRevisionRange.value;
    if (range.startIndex < 0) {
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
    if (selectedRevision.value?.isNoNetChange) {
      return {
        mode: "noop",
        reason: "no-net-change",
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
      targetIndex: range.startIndex,
      targetRange: range,
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

  const hasMore = computed(() => (
    state.localHasMore || state.sharedHasMore || state.hasHeldBackRevisions
  ));

  function buildAuditRevisionsSlice({ allowIncompleteFallback = false } = {}) {
    const selfLabel = getSelfLabel();
    const merged = mergeTableAuditEntries({
      localEntries: state.rawLocal,
      sharedEntries: state.rawShared,
      selfLabel,
    });
    const allAuditRevisions = groupAuditRevisions(merged);
    if (!state.localHasMore && !state.sharedHasMore) {
      return {
        auditRevisions: allAuditRevisions,
        hasHeldBack: false,
        localHorizon: { horizonMs: Number.NEGATIVE_INFINITY },
        sharedHorizon: { horizonMs: Number.NEGATIVE_INFINITY },
      };
    }

    const localHorizon = inspectStreamRevisionHorizon(state.rawLocal, state.localHasMore, { selfLabel });
    const sharedHorizon = inspectStreamRevisionHorizon(state.rawShared, state.sharedHasMore, { selfLabel });
    const safeHorizonMs = Math.max(localHorizon.horizonMs, sharedHorizon.horizonMs);

    const completePrefix = allAuditRevisions.filter((rev) => rev.tsMs > safeHorizonMs);
    if (completePrefix.length > 0 || !allowIncompleteFallback) {
      return {
        auditRevisions: completePrefix,
        hasHeldBack: completePrefix.length < allAuditRevisions.length,
        localHorizon,
        sharedHorizon,
      };
    }

    // Safety fallback if a single extraordinary operation exceeded MAX_PAGES_PER_BATCH:
    // surface what is loaded so the screen is not blank, but flag unclosed boundary
    // revisions as incomplete so partial restore is strictly blocked.
    return {
      auditRevisions: allAuditRevisions.map((rev) => (
        rev.tsMs <= safeHorizonMs ? { ...rev, isIncomplete: true } : rev
      )),
      hasHeldBack: false,
      localHorizon,
      sharedHorizon,
    };
  }

  function recomputeRevisions({ allowIncompleteFallback = false } = {}) {
    const { auditRevisions, hasHeldBack } = buildAuditRevisionsSlice({ allowIncompleteFallback });
    state.hasHeldBackRevisions = hasHeldBack;
    const localExternal = state.observedExternal
      ? [state.observedExternal, ...state.rawLocalExternal]
      : state.rawLocalExternal;
    const externalRevisions = mergeTableExternalChanges({
      localEntries: localExternal,
      sharedEntries: state.rawSharedExternal,
      tableMeta: effectiveTableMeta.value,
      auditRevisions,
    });
    const visibleExternal = (state.localHasMore || state.sharedHasMore) && auditRevisions.length > 0
      ? externalRevisions.filter((ext) => ext.tsMs >= (auditRevisions[auditRevisions.length - 1]?.tsMs || 0))
      : externalRevisions;
    state.revisions = mergeTimelineRevisions(auditRevisions, visibleExternal);
    const displayed = displayRevisions.value;
    if (
      state.selectedRevisionId
      && findSelectionInList(displayed, state.selectedRevisionId)
    ) {
      return;
    }
    state.selectedRevisionId = displayed[0]?.id || "";
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
    const previousAuditCount = append
      ? state.revisions.filter((rev) => !rev.isExternal).length
      : 0;
    const targetAuditCount = previousAuditCount + REVISIONS_PER_BATCH;

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
      state.hasHeldBackRevisions = false;
      state.rawLocal = [];
      state.rawShared = [];
      state.rawLocalExternal = [];
      state.rawSharedExternal = [];
      state.observedExternal = null;
      state.revisions = [];
      state.selectedRevisionId = "";
      state.expandedSessionIds = [];
      state.actorFilter = "";
      state.activeChangeIndex = 0;
      state.activeMatchIndex = 0;
    }

    const signedIn = Boolean(isLoggedIn());
    if (!signedIn) {
      state.sharedStatus = "logged-out";
      state.sharedHasMore = false;
    }

    const fetchLocalPage = () => invokeWorkbench("list_audit_logs", {
      request: {
        connectionId: state.connectionId || undefined,
        database: state.database,
        tableName: state.tableName,
        committedOnly: true,
        limit: AUDIT_PAGE_LIMIT,
        offset: state.localOffset,
      },
    }).then((rows) => ({ ok: true, rows: Array.isArray(rows) ? rows : [] }))
      .catch((error) => ({ ok: false, error: String(error?.message || error || "读取本机记录失败") }));

    const fetchSharedPage = () => invokeWorkbench("list_shared_audit_logs", {
      request: {
        // Omit connectionId intentionally so teammates whose local
        // connection numbering differs still match this table; scope by
        // serverScopeConnectionId when available.
        serverScopeConnectionId: state.connectionId || undefined,
        database: state.database,
        tableName: state.tableName,
        committedOnly: true,
        limit: AUDIT_PAGE_LIMIT,
        offset: state.sharedOffset,
      },
    }).then((rows) => ({ ok: true, rows: Array.isArray(rows) ? rows : [] }))
      .catch((error) => ({ ok: false, error: String(error?.message || error || "读取团队记录失败") }));

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

    let needLocal = !append || state.localHasMore;
    let needShared = signedIn && (!append || state.sharedHasMore);
    let pagesFetched = 0;
    let localFailed = false;
    let localErrorMsg = "";
    let sharedFailed = false;

    const [
      firstLocalRes,
      firstSharedRes,
      localExternalRows,
      sharedExternalRows,
      observedRes,
    ] = await Promise.all([
      needLocal ? fetchLocalPage() : Promise.resolve({ ok: true, rows: null }),
      needShared ? fetchSharedPage() : Promise.resolve({ ok: true, rows: null }),
      localExternalPromise,
      sharedExternalPromise,
      observeExternalPromise,
    ]);
    if (activeGen !== loadGeneration) return;

    const applyPageResults = (localRes, sharedRes) => {
      if (localRes && localRes.rows !== null) {
        if (localRes.ok && Array.isArray(localRes.rows)) {
          state.localOffset += localRes.rows.length;
          state.localHasMore = localRes.rows.length >= AUDIT_PAGE_LIMIT;
          state.rawLocal = state.rawLocal.length
            ? [...state.rawLocal, ...localRes.rows]
            : localRes.rows;
        } else if (!localRes.ok) {
          localFailed = true;
          localErrorMsg = localRes.error || "";
          state.localHasMore = false;
        }
      }

      if (signedIn && sharedRes && sharedRes.rows !== null) {
        if (sharedRes.ok && Array.isArray(sharedRes.rows)) {
          state.sharedStatus = "loaded";
          state.sharedOffset += sharedRes.rows.length;
          state.sharedHasMore = sharedRes.rows.length >= AUDIT_PAGE_LIMIT;
          state.rawShared = state.rawShared.length
            ? [...state.rawShared, ...sharedRes.rows]
            : sharedRes.rows;
        } else if (!sharedRes.ok) {
          sharedFailed = true;
          state.sharedStatus = "error";
          state.sharedError = sharedRes.error || "";
          state.sharedHasMore = false;
        }
      }
    };

    if (needLocal || needShared) pagesFetched += 1;
    applyPageResults(firstLocalRes, firstSharedRes);

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

    // Drain additional pages automatically until every visible revision's batch
    // boundary is closed (preventing partial counts like "改 200" on multi-row
    // Excel imports) and we have advanced the gapless timeline horizon.
    while (pagesFetched < MAX_PAGES_PER_BATCH && (state.localHasMore || state.sharedHasMore)) {
      const slice = buildAuditRevisionsSlice({ allowIncompleteFallback: false });
      if (slice.auditRevisions.length >= targetAuditCount) {
        break;
      }
      const nextLocal = state.localHasMore && (
        !state.sharedHasMore || slice.localHorizon.horizonMs >= slice.sharedHorizon.horizonMs
      );
      const nextShared = signedIn && state.sharedHasMore && (
        !state.localHasMore || slice.sharedHorizon.horizonMs >= slice.localHorizon.horizonMs
      );
      if (!nextLocal && !nextShared) break;

      pagesFetched += 1;
      const [moreLocal, moreShared] = await Promise.all([
        nextLocal ? fetchLocalPage() : Promise.resolve({ ok: true, rows: null }),
        nextShared ? fetchSharedPage() : Promise.resolve({ ok: true, rows: null }),
      ]);
      if (activeGen !== loadGeneration) return;
      applyPageResults(moreLocal, moreShared);
    }

    if (localFailed && (!signedIn || sharedFailed) && !state.rawLocal.length && !state.rawShared.length) {
      state.error = localErrorMsg || state.sharedError || "读取修改历史失败";
    }

    recomputeRevisions({
      allowIncompleteFallback: pagesFetched >= MAX_PAGES_PER_BATCH,
    });
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

  function isSessionExpanded(sessionId) {
    return state.expandedSessionIds.includes(String(sessionId || ""));
  }

  function toggleSessionExpanded(sessionId) {
    const id = String(sessionId || "");
    if (!id) return;
    if (state.expandedSessionIds.includes(id)) {
      state.expandedSessionIds = state.expandedSessionIds.filter((item) => item !== id);
    } else {
      state.expandedSessionIds = [...state.expandedSessionIds, id];
    }
  }

  function setActorFilter(actor) {
    state.actorFilter = state.actorFilter === actor ? "" : String(actor || "");
    const visible = filteredRevisions.value;
    if (visible.length && !findSelectionInList(visible, state.selectedRevisionId)) {
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
    displayRevisions,
    actors,
    filteredRevisions,
    selectedRevision,
    selectedRevisionRange,
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
    isSessionExpanded,
    toggleSessionExpanded,
    setActorFilter,
    setDisplayScope,
    setSearchQuery,
    stepChange,
    stepSearchMatch,
    refresh,
    loadMore,
  };
}

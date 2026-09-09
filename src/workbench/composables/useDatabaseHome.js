import { computed, ref } from "vue";
import { rankTableSearchResults } from "../utils/tableSearch.js";

export const HOME_SORT_MODES = Object.freeze({
  nameAsc: "nameAsc",
  nameDesc: "nameDesc",
  commentFirst: "commentFirst",
  commentDesc: "commentDesc",
  fieldsAsc: "fieldsAsc",
  fieldsDesc: "fieldsDesc",
  sizeAsc: "sizeAsc",
  sizeDesc: "sizeDesc",
  modifiedAsc: "modifiedAsc",
  modifiedDesc: "modifiedDesc",
  recent: "recent",
  original: "original",
});

function tableNameOf(table) {
  return String(table?.tableName || table?.table_name || table?.name || "").trim();
}

function tableCommentOf(table) {
  return String(table?.tableComment || table?.table_comment || table?.comment || "").trim();
}

function numericCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function tableColumnCountOf(table) {
  for (const value of [table?.columnCount, table?.column_count, table?.fieldCount, table?.field_count]) {
    const count = numericCount(value);
    if (count !== null) return count;
  }
  if (Array.isArray(table?.columns) && table?.schemaLoaded !== false) return table.columns.length;
  return null;
}

function tableDataSizeOf(table) {
  for (const value of [table?.dataSizeBytes, table?.data_size_bytes]) {
    if (value === null || value === undefined || value === "") continue;
    const size = Number(value);
    if (Number.isFinite(size) && size >= 0) return size;
  }
  return null;
}

function tableModifiedAtOf(table) {
  const text = String(table?.modifiedAt || table?.modified_at || "").trim();
  if (!text) return { text: "", timestamp: null };
  const timestamp = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  return { text, timestamp: Number.isFinite(timestamp) ? timestamp : null };
}

function normalizeTable(table, index) {
  const tableName = tableNameOf(table);
  const modified = tableModifiedAtOf(table);
  return {
    ...table,
    tableName,
    tableComment: tableCommentOf(table),
    columnCount: tableColumnCountOf(table),
    dataSizeBytes: tableDataSizeOf(table),
    modifiedAt: modified.text,
    modifiedTimestamp: modified.timestamp,
    originalIndex: index,
  };
}

function compareName(left, right) {
  return left.tableName.localeCompare(right.tableName, undefined, { sensitivity: "base", numeric: true });
}

function compareComment(left, right) {
  return tableCommentOf(left).localeCompare(tableCommentOf(right), undefined, { sensitivity: "base", numeric: true });
}

function compareFieldCount(left, right) {
  return compareNullableNumber(left.columnCount, right.columnCount, 1);
}

function compareNullableNumber(left, right, direction = 1) {
  const leftNumber = left === null || left === undefined || !Number.isFinite(Number(left)) ? null : Number(left);
  const rightNumber = right === null || right === undefined || !Number.isFinite(Number(right)) ? null : Number(right);
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return 1;
  if (rightNumber === null) return -1;
  return (leftNumber - rightNumber) * direction;
}

function eventHasCtrl(event = {}) {
  return Boolean(event.ctrlKey || event.metaKey);
}

function selectedArray(selected) {
  return Array.from(selected);
}

function sourceArray(value) {
  const list = Array.isArray(value?.value) ? value.value : value;
  return Array.isArray(list) ? list : [];
}

export function databaseHomeRenameError(reason, nextName = "", error = null) {
  const tableName = String(nextName || "").trim();
  if (reason === "duplicate") {
    return tableName ? `表名“${tableName}”已存在，请换一个名称` : "表名已存在，请换一个名称";
  }
  if (reason === "invalid") return "表名不能包含 /、\\ 或空字符";
  if (reason === "empty") return "请输入新的表名";

  const detail = String(error?.message || error || "").trim();
  if (/已存在|already exists|duplicate/i.test(detail)) {
    return tableName ? `表名“${tableName}”已存在，请换一个名称` : "表名已存在，请换一个名称";
  }
  return detail ? `重命名失败：${detail}` : "重命名失败，请重试";
}

export function createDatabaseHomeController({
  connectionId = "",
  database = "",
  tables = [],
  recentTableNames = [],
  favoriteTableNames = [],
  readOnly = false,
  allowRenameDrop = undefined,
  allowTableCopy = undefined,
  clipboard: clipboardRef = null,
  initialQuery = "",
  initialSortMode = HOME_SORT_MODES.nameAsc,
} = {}) {
  const query = ref(String(initialQuery || ""));
  const sortMode = ref(initialSortMode || HOME_SORT_MODES.nameAsc);
  const selectedNames = ref([]);
  const anchorName = ref("");
  const focusedName = ref("");
  const renamingName = ref("");
  const renameDraft = ref("");
  const renameError = ref("");
  const renamePending = ref(false);
  let renameAttempt = 0;
  const clipboard = clipboardRef || ref(null);
  const recentRank = computed(() =>
    new Map(sourceArray(recentTableNames).map((name, index) => [String(name).toLowerCase(), index])),
  );
  const favoriteSet = computed(() => new Set(
    sourceArray(favoriteTableNames).map((name) => tableNameOf({ tableName: name })).filter(Boolean),
  ));

  const normalizedTables = computed(() => sourceArray(tables).map(normalizeTable));
  const sortState = computed(() => {
    switch (sortMode.value) {
      case HOME_SORT_MODES.nameDesc:
        return { column: "name", direction: "desc" };
      case HOME_SORT_MODES.commentFirst:
        return { column: "comment", direction: "asc" };
      case HOME_SORT_MODES.commentDesc:
        return { column: "comment", direction: "desc" };
      case HOME_SORT_MODES.fieldsAsc:
        return { column: "fields", direction: "asc" };
      case HOME_SORT_MODES.fieldsDesc:
        return { column: "fields", direction: "desc" };
      case HOME_SORT_MODES.sizeAsc:
        return { column: "size", direction: "asc" };
      case HOME_SORT_MODES.sizeDesc:
        return { column: "size", direction: "desc" };
      case HOME_SORT_MODES.modifiedAsc:
        return { column: "modified", direction: "asc" };
      case HOME_SORT_MODES.modifiedDesc:
        return { column: "modified", direction: "desc" };
      case HOME_SORT_MODES.recent:
        return { column: "recent", direction: "desc" };
      case HOME_SORT_MODES.original:
        return { column: "original", direction: "" };
      case HOME_SORT_MODES.nameAsc:
      default:
        return { column: "name", direction: "asc" };
    }
  });
  const filteredTables = computed(() => {
    const text = query.value.trim();
    if (text) {
      return rankTableSearchResults(normalizedTables.value, text, { mode: "contains" }).map(({ table }) => table);
    }
    const list = [...normalizedTables.value];
    const favoritePriority = (left, right) =>
      Number(favoriteSet.value.has(right.tableName)) - Number(favoriteSet.value.has(left.tableName));
    const sort = (compare) => list.sort((left, right) => favoritePriority(left, right) || compare(left, right));
    switch (sortMode.value) {
      case HOME_SORT_MODES.nameDesc:
        return sort((left, right) => compareName(right, left) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.commentFirst:
        return sort((left, right) => {
          const leftHasComment = tableCommentOf(left) ? 0 : 1;
          const rightHasComment = tableCommentOf(right) ? 0 : 1;
          return leftHasComment - rightHasComment || compareName(left, right) || left.originalIndex - right.originalIndex;
        });
      case HOME_SORT_MODES.commentDesc:
        return sort((left, right) => {
          const leftHasComment = tableCommentOf(left) ? 0 : 1;
          const rightHasComment = tableCommentOf(right) ? 0 : 1;
          return leftHasComment - rightHasComment || compareComment(right, left) || compareName(left, right) || left.originalIndex - right.originalIndex;
        });
      case HOME_SORT_MODES.fieldsAsc:
        return sort((left, right) => compareFieldCount(left, right) || compareName(left, right) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.fieldsDesc:
        return sort((left, right) => compareNullableNumber(left.columnCount, right.columnCount, -1) || compareName(left, right) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.sizeAsc:
        return sort((left, right) => compareNullableNumber(left.dataSizeBytes, right.dataSizeBytes, 1) || compareName(left, right) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.sizeDesc:
        return sort((left, right) => compareNullableNumber(left.dataSizeBytes, right.dataSizeBytes, -1) || compareName(left, right) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.modifiedAsc:
        return sort((left, right) => compareNullableNumber(left.modifiedTimestamp, right.modifiedTimestamp, 1) || compareName(left, right) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.modifiedDesc:
        return sort((left, right) => compareNullableNumber(left.modifiedTimestamp, right.modifiedTimestamp, -1) || compareName(left, right) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.recent:
        return sort((left, right) => {
          const leftRank = recentRank.value.get(left.tableName.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
          const rightRank = recentRank.value.get(right.tableName.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
          return leftRank - rightRank || compareName(left, right) || left.originalIndex - right.originalIndex;
        });
      case HOME_SORT_MODES.original:
        return sort((left, right) => left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.nameAsc:
      default:
        return sort((left, right) => compareName(left, right) || left.originalIndex - right.originalIndex);
    }
  });

  const selectedSet = computed(() => new Set(selectedNames.value));
  const canWrite = computed(() => !readOnly);
  const renameDropEnabled = allowRenameDrop ?? !readOnly;
  const tableCopyEnabled = allowTableCopy ?? !readOnly;
  const canCopy = computed(() => tableCopyEnabled && selectedNames.value.length > 0);
  const canRename = computed(() => renameDropEnabled && selectedNames.value.length === 1);
  const canDelete = computed(() => renameDropEnabled && selectedNames.value.length > 0);
  const canPaste = computed(() => tableCopyEnabled && clipboard.value?.type === "dbscout.tableObjects" && clipboard.value?.tables?.length > 0);

  function setQuery(value) {
    query.value = String(value || "");
  }

  function setSortMode(value) {
    sortMode.value = Object.values(HOME_SORT_MODES).includes(value) ? value : HOME_SORT_MODES.nameAsc;
  }

  function sortByColumn(column) {
    const name = String(column || "");
    if (name === "name") {
      sortMode.value = sortMode.value === HOME_SORT_MODES.nameAsc ? HOME_SORT_MODES.nameDesc : HOME_SORT_MODES.nameAsc;
      return sortMode.value;
    }
    if (name === "comment") {
      sortMode.value = sortMode.value === HOME_SORT_MODES.commentFirst ? HOME_SORT_MODES.commentDesc : HOME_SORT_MODES.commentFirst;
      return sortMode.value;
    }
    if (name === "fields") {
      sortMode.value = sortMode.value === HOME_SORT_MODES.fieldsDesc ? HOME_SORT_MODES.fieldsAsc : HOME_SORT_MODES.fieldsDesc;
      return sortMode.value;
    }
    if (name === "size") {
      sortMode.value = sortMode.value === HOME_SORT_MODES.sizeDesc ? HOME_SORT_MODES.sizeAsc : HOME_SORT_MODES.sizeDesc;
      return sortMode.value;
    }
    if (name === "modified") {
      sortMode.value = sortMode.value === HOME_SORT_MODES.modifiedDesc ? HOME_SORT_MODES.modifiedAsc : HOME_SORT_MODES.modifiedDesc;
      return sortMode.value;
    }
    sortMode.value = HOME_SORT_MODES.original;
    return sortMode.value;
  }

  function tableIndex(name) {
    return filteredTables.value.findIndex((table) => table.tableName === name);
  }

  function selectTable(name, event = {}) {
    const safeName = tableNameOf({ tableName: name });
    if (!safeName) return selectedNames.value;
    focusedName.value = safeName;
    const current = new Set(selectedNames.value);
    if (event.shiftKey && anchorName.value) {
      const start = tableIndex(anchorName.value);
      const end = tableIndex(safeName);
      if (start >= 0 && end >= 0) {
        const [from, to] = start <= end ? [start, end] : [end, start];
        selectedNames.value = filteredTables.value.slice(from, to + 1).map((table) => table.tableName);
        return selectedNames.value;
      }
    }
    if (eventHasCtrl(event)) {
      if (current.has(safeName)) current.delete(safeName);
      else current.add(safeName);
      selectedNames.value = selectedArray(current);
      anchorName.value = safeName;
      return selectedNames.value;
    }
    selectedNames.value = [safeName];
    anchorName.value = safeName;
    return selectedNames.value;
  }

  function clearSelection() {
    selectedNames.value = [];
    anchorName.value = "";
  }

  function selectAllFiltered() {
    selectedNames.value = filteredTables.value.map((table) => table.tableName);
    anchorName.value = selectedNames.value[0] || "";
    if (!focusedName.value || !selectedNames.value.includes(focusedName.value)) {
      focusedName.value = selectedNames.value.at(-1) || "";
    }
    return selectedNames.value;
  }

  function moveSelection(delta, event = {}) {
    const list = filteredTables.value;
    const step = Math.sign(Number(delta) || 0);
    if (!list.length || !step) return "";

    const currentName = focusedName.value || selectedNames.value.at(-1) || "";
    const currentIndex = tableIndex(currentName);
    const nextIndex = currentIndex < 0
      ? (step > 0 ? 0 : list.length - 1)
      : Math.max(0, Math.min(list.length - 1, currentIndex + step));
    const nextName = list[nextIndex]?.tableName || "";
    if (!nextName) return "";

    selectTable(nextName, { shiftKey: Boolean(event.shiftKey) });
    return nextName;
  }

  function setSelection(names = []) {
    const validNames = new Set(normalizedTables.value.map((table) => table.tableName));
    const next = [];
    const seen = new Set();
    sourceArray(names).forEach((name) => {
      const safeName = tableNameOf({ tableName: name });
      if (!safeName || !validNames.has(safeName) || seen.has(safeName)) return;
      seen.add(safeName);
      next.push(safeName);
    });
    selectedNames.value = next;
    anchorName.value = next[0] || "";
    if (next.length && !next.includes(focusedName.value)) focusedName.value = next.at(-1);
    return selectedNames.value;
  }

  function startRename(name = "") {
    const targetName = tableNameOf({ tableName: name }) || selectedNames.value[0] || "";
    if (!canRename.value || !targetName) return false;
    renamingName.value = targetName;
    renameDraft.value = targetName;
    renameError.value = "";
    renamePending.value = false;
    return true;
  }

  function cancelRename() {
    renameAttempt += 1;
    renamingName.value = "";
    renameDraft.value = "";
    renameError.value = "";
    renamePending.value = false;
  }

  function updateRenameDraft(value) {
    renameDraft.value = String(value ?? "");
    renameError.value = "";
  }

  function beginRenameSubmit() {
    renameAttempt += 1;
    renameError.value = "";
    renamePending.value = true;
    return renameAttempt;
  }

  function failRename(message, attempt = null) {
    if (attempt !== null && attempt !== renameAttempt) return false;
    renamePending.value = false;
    renameError.value = String(message || "");
    return true;
  }

  function completeRename(attempt) {
    if (attempt !== renameAttempt) return false;
    cancelRename();
    return true;
  }

  function resetTransientViewState() {
    clearSelection();
    cancelRename();
  }

  function resetForRefresh() {
    query.value = "";
    sortMode.value = HOME_SORT_MODES.nameAsc;
    resetTransientViewState();
  }

  function resetForMutationRefresh() {
    resetTransientViewState();
  }

  function validateRenameDraft(oldName, newName) {
    const previous = tableNameOf({ tableName: oldName });
    const value = String(newName || "").trim();
    if (!value) return { ok: false, reason: "empty" };
    if (value === previous) return { ok: false, reason: "unchanged" };
    if (/[\\/\0]/.test(value)) return { ok: false, reason: "invalid" };
    const duplicate = normalizedTables.value.some((table) =>
      table.tableName.toLowerCase() === value.toLowerCase() && table.tableName !== previous);
    if (duplicate) return { ok: false, reason: "duplicate" };
    return { ok: true, value };
  }

  function copySelection() {
    if (!canCopy.value) return null;
    const payload = {
      type: "dbscout.tableObjects",
      connectionId,
      database,
      tables: [...selectedNames.value],
    };
    clipboard.value = payload;
    return payload;
  }

  return {
    query,
    sortMode,
    tables: normalizedTables,
    filteredTables,
    sortState,
    selectedNames,
    selectedSet,
    anchorName,
    focusedName,
    renamingName,
    renameDraft,
    renameError,
    renamePending,
    clipboard,
    canWrite,
    canCopy,
    canPaste,
    canRename,
    canDelete,
    setQuery,
    setSortMode,
    sortByColumn,
    selectTable,
    clearSelection,
    selectAllFiltered,
    moveSelection,
    setSelection,
    startRename,
    cancelRename,
    updateRenameDraft,
    beginRenameSubmit,
    failRename,
    completeRename,
    resetForRefresh,
    resetForMutationRefresh,
    validateRenameDraft,
    copySelection,
  };
}

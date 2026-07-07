import { computed, ref } from "vue";

export const HOME_SORT_MODES = Object.freeze({
  nameAsc: "nameAsc",
  nameDesc: "nameDesc",
  commentFirst: "commentFirst",
  recent: "recent",
  original: "original",
});

function tableNameOf(table) {
  return String(table?.tableName || table?.table_name || table?.name || "").trim();
}

function tableCommentOf(table) {
  return String(table?.tableComment || table?.table_comment || table?.comment || "").trim();
}

function normalizeTable(table, index) {
  const tableName = tableNameOf(table);
  return {
    ...table,
    tableName,
    tableComment: tableCommentOf(table),
    columnCount: Array.isArray(table?.columns) ? table.columns.length : null,
    originalIndex: index,
  };
}

function compareName(left, right) {
  return left.tableName.localeCompare(right.tableName, undefined, { sensitivity: "base", numeric: true });
}

function includesText(value, query) {
  return String(value || "").toLowerCase().includes(String(query || "").toLowerCase());
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

export function createDatabaseHomeController({
  connectionId = "",
  database = "",
  tables = [],
  recentTableNames = [],
  readOnly = false,
  clipboard: clipboardRef = null,
  initialQuery = "",
  initialSortMode = HOME_SORT_MODES.nameAsc,
} = {}) {
  const query = ref(String(initialQuery || ""));
  const sortMode = ref(initialSortMode || HOME_SORT_MODES.nameAsc);
  const selectedNames = ref([]);
  const anchorName = ref("");
  const renamingName = ref("");
  const renameDraft = ref("");
  const clipboard = clipboardRef || ref(null);
  const recentRank = computed(() =>
    new Map(sourceArray(recentTableNames).map((name, index) => [String(name).toLowerCase(), index])),
  );

  const normalizedTables = computed(() => sourceArray(tables).map(normalizeTable));
  const filteredTables = computed(() => {
    const text = query.value.trim().toLowerCase();
    const list = text
      ? normalizedTables.value.filter((table) =>
          includesText(table.tableName, text) || includesText(table.tableComment, text))
      : [...normalizedTables.value];
    switch (sortMode.value) {
      case HOME_SORT_MODES.nameDesc:
        return list.sort((left, right) => compareName(right, left) || left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.commentFirst:
        return list.sort((left, right) => {
          const leftHasComment = tableCommentOf(left) ? 0 : 1;
          const rightHasComment = tableCommentOf(right) ? 0 : 1;
          return leftHasComment - rightHasComment || compareName(left, right) || left.originalIndex - right.originalIndex;
        });
      case HOME_SORT_MODES.recent:
        return list.sort((left, right) => {
          const leftRank = recentRank.value.get(left.tableName.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
          const rightRank = recentRank.value.get(right.tableName.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
          return leftRank - rightRank || compareName(left, right) || left.originalIndex - right.originalIndex;
        });
      case HOME_SORT_MODES.original:
        return list.sort((left, right) => left.originalIndex - right.originalIndex);
      case HOME_SORT_MODES.nameAsc:
      default:
        return list.sort((left, right) => compareName(left, right) || left.originalIndex - right.originalIndex);
    }
  });

  const selectedSet = computed(() => new Set(selectedNames.value));
  const canWrite = computed(() => !readOnly);
  const canCopy = computed(() => canWrite.value && selectedNames.value.length > 0);
  const canRename = computed(() => canWrite.value && selectedNames.value.length === 1);
  const canDelete = computed(() => canWrite.value && selectedNames.value.length > 0);
  const canPaste = computed(() => canWrite.value && clipboard.value?.type === "dbscout.tableObjects" && clipboard.value?.tables?.length > 0);

  function setQuery(value) {
    query.value = String(value || "");
  }

  function setSortMode(value) {
    sortMode.value = Object.values(HOME_SORT_MODES).includes(value) ? value : HOME_SORT_MODES.nameAsc;
  }

  function tableIndex(name) {
    return filteredTables.value.findIndex((table) => table.tableName === name);
  }

  function selectTable(name, event = {}) {
    const safeName = tableNameOf({ tableName: name });
    if (!safeName) return selectedNames.value;
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

  function startRename(name = "") {
    const targetName = tableNameOf({ tableName: name }) || selectedNames.value[0] || "";
    if (!canRename.value || !targetName) return false;
    renamingName.value = targetName;
    renameDraft.value = targetName;
    return true;
  }

  function cancelRename() {
    renamingName.value = "";
    renameDraft.value = "";
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
    selectedNames,
    selectedSet,
    anchorName,
    renamingName,
    renameDraft,
    clipboard,
    canWrite,
    canCopy,
    canPaste,
    canRename,
    canDelete,
    setQuery,
    setSortMode,
    selectTable,
    clearSelection,
    startRename,
    cancelRename,
    validateRenameDraft,
    copySelection,
  };
}

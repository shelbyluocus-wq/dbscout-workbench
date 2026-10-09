import { ref } from "vue";

export const SQL_QUERY_DOCUMENTS_STORAGE_KEY = "dbscout.sql-query-documents.v1";

let fallbackIdSequence = 0;

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function defaultNow() {
  return new Date().toISOString();
}

function defaultCreateId() {
  if (globalThis.crypto?.randomUUID) return `sql-doc-${globalThis.crypto.randomUUID()}`;
  fallbackIdSequence += 1;
  return `sql-doc-${Date.now()}-${fallbackIdSequence}`;
}

function normalizedTitle(value, fallback = "未命名查询") {
  return String(value || "").trim().slice(0, 120) || fallback;
}

function normalizeDocument(value, { now, createId = defaultCreateId, allowCreateId = false } = {}) {
  const id = String(value?.id || (allowCreateId ? createId() : "")).trim();
  if (!id) return null;
  if (now === undefined) now = defaultNow();
  const sql = String(value?.sql || "");
  const savedSql = String(value?.savedSql ?? (value?.filePath ? sql : ""));
  const createdAt = String(value?.createdAt || now);
  return {
    id,
    title: normalizedTitle(value?.title || value?.fileName),
    sql,
    savedSql,
    dirty: value?.dirty == null ? sql !== savedSql : Boolean(value.dirty),
    filePath: String(value?.filePath || ""),
    fileName: String(value?.fileName || ""),
    connectionId: String(value?.connectionId || ""),
    database: String(value?.database || ""),
    readOnly: Boolean(value?.readOnly || value?.read_only),
    createdAt,
    updatedAt: String(value?.updatedAt || createdAt),
    lastOpenedAt: String(value?.lastOpenedAt || value?.updatedAt || createdAt),
  };
}

let titleCollator = null;

function compareTitles(left, right) {
  // localeCompare with an explicit locale may build a collator per call.
  if (!titleCollator) titleCollator = new Intl.Collator("zh-CN");
  return titleCollator.compare(left, right);
}

function sortDocuments(documents) {
  return [...documents].sort((left, right) => {
    const updated = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    if (updated) return updated;
    return compareTitles(String(left.title || ""), String(right.title || ""));
  });
}

function documentSignature(document) {
  return [
    document.title,
    document.sql,
    document.savedSql,
    String(document.filePath || "").toLocaleLowerCase(),
    document.connectionId,
    document.database,
  ].join("\u001f");
}

function dedupeExactDocuments(documents) {
  const signatures = new Set();
  return sortDocuments(documents).filter((document) => {
    const signature = documentSignature(document);
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  });
}

function sameFilePath(left, right) {
  const leftPath = String(left || "").trim().toLocaleLowerCase();
  const rightPath = String(right || "").trim().toLocaleLowerCase();
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

function documentContentChanged(previous, next) {
  return [
    "title",
    "sql",
    "savedSql",
    "dirty",
    "filePath",
    "fileName",
    "connectionId",
    "database",
    "readOnly",
  ].some((key) => previous?.[key] !== next?.[key]);
}

export function loadSqlQueryDocuments(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(SQL_QUERY_DOCUMENTS_STORAGE_KEY) || "null");
    if (parsed?.version !== 1 || !Array.isArray(parsed.documents)) return [];
    return dedupeExactDocuments(parsed.documents.map((item) => normalizeDocument(item)).filter(Boolean));
  } catch {
    return [];
  }
}

export function saveSqlQueryDocuments(documents, storage = defaultStorage()) {
  const now = defaultNow();
  const normalized = dedupeExactDocuments((Array.isArray(documents) ? documents : [])
    .map((item) => normalizeDocument(item, { now }))
    .filter(Boolean));
  try {
    storage?.setItem?.(SQL_QUERY_DOCUMENTS_STORAGE_KEY, JSON.stringify({ version: 1, documents: normalized }));
  } catch {
    // Query drafts remain usable for the current session when storage is unavailable.
  }
  return normalized;
}

export function nextSqlQueryTitle(documents = []) {
  const highest = documents.reduce((value, document) => {
    const match = String(document?.title || "").match(/^查询\s+(\d+)$/);
    return Math.max(value, Number(match?.[1]) || 0);
  }, 0);
  return `查询 ${highest + 1}`;
}

export function createSqlQueryDocumentStore({
  storage = defaultStorage(),
  now = defaultNow,
  createId = defaultCreateId,
  initialDocuments,
} = {}) {
  const documents = ref(initialDocuments === undefined
    ? loadSqlQueryDocuments(storage)
    : dedupeExactDocuments(initialDocuments.map((item) => normalizeDocument(item)).filter(Boolean)));

  function commit(next) {
    documents.value = saveSqlQueryDocuments(next, storage);
    return documents.value;
  }

  function findDocument(id) {
    return documents.value.find((document) => document.id === String(id || "")) || null;
  }

  function findByFilePath(path) {
    return documents.value.find((document) => sameFilePath(document.filePath, path)) || null;
  }

  function createDocument(values = {}) {
    const timestamp = now();
    const document = normalizeDocument({
      ...values,
      id: values.id || createId(),
      title: values.title || values.fileName || nextSqlQueryTitle(documents.value),
      createdAt: values.createdAt || timestamp,
      updatedAt: values.updatedAt || timestamp,
      lastOpenedAt: values.lastOpenedAt || timestamp,
    }, { now: timestamp, createId, allowCreateId: true });
    commit([document, ...documents.value.filter((item) => item.id !== document.id)]);
    return findDocument(document.id);
  }

  function updateDocument(id, patch = {}, { touch = true } = {}) {
    const previous = findDocument(id);
    if (!previous) return null;
    const timestamp = now();
    const next = normalizeDocument({
      ...previous,
      ...patch,
      id: previous.id,
      createdAt: previous.createdAt,
      updatedAt: touch ? timestamp : previous.updatedAt,
    }, { now: timestamp, createId });
    commit(documents.value.map((document) => document.id === previous.id ? next : document));
    return findDocument(previous.id);
  }

  function upsertFromTab(tab) {
    if (!tab || tab.kind !== "sql") return null;
    const previous = findDocument(tab.documentId) || findByFilePath(tab.filePath);
    const timestamp = now();
    const candidate = normalizeDocument({
      ...previous,
      id: previous?.id || tab.documentId || createId(),
      title: tab.title || tab.fileName || previous?.title || nextSqlQueryTitle(documents.value),
      sql: tab.sql,
      savedSql: tab.savedSql,
      dirty: tab.dirty,
      filePath: tab.filePath,
      fileName: tab.fileName,
      connectionId: tab.connectionId,
      database: tab.database,
      readOnly: tab.readOnly || tab.read_only,
      createdAt: previous?.createdAt || timestamp,
      updatedAt: previous?.updatedAt || timestamp,
      lastOpenedAt: previous?.lastOpenedAt || timestamp,
    }, { now: timestamp, createId });
    if (previous && documentContentChanged(previous, candidate)) candidate.updatedAt = timestamp;
    tab.documentId = candidate.id;
    commit([candidate, ...documents.value.filter((document) => document.id !== candidate.id)]);
    return findDocument(candidate.id);
  }

  function markOpened(id) {
    return updateDocument(id, { lastOpenedAt: now() }, { touch: false });
  }

  function duplicateDocument(id) {
    const source = findDocument(id);
    if (!source) return null;
    return createDocument({
      title: `${source.title} 副本`,
      sql: source.sql,
      savedSql: "",
      dirty: Boolean(source.sql),
      connectionId: source.connectionId,
      database: source.database,
      readOnly: source.readOnly,
    });
  }

  function removeDocument(id) {
    const key = String(id || "");
    const previous = findDocument(key);
    if (!previous) return null;
    commit(documents.value.filter((document) => document.id !== key));
    return previous;
  }

  return {
    documents,
    findDocument,
    findByFilePath,
    createDocument,
    updateDocument,
    upsertFromTab,
    markOpened,
    duplicateDocument,
    removeDocument,
  };
}

const sharedSqlQueryDocumentStore = createSqlQueryDocumentStore();

export function useSqlQueryDocumentStore() {
  return sharedSqlQueryDocumentStore;
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  SQL_QUERY_DOCUMENTS_STORAGE_KEY,
  createSqlQueryDocumentStore,
  loadSqlQueryDocuments,
  nextSqlQueryTitle,
} from "./composables/sqlQueryDocumentStore.js";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); },
  };
}

test("SQL query documents persist independently from open tabs", () => {
  const storage = createStorage();
  let tick = 0;
  const store = createSqlQueryDocumentStore({
    storage,
    now: () => `2026-07-15T00:00:0${tick++}.000Z`,
    createId: () => `doc-${tick}`,
  });

  const first = store.createDocument({ connectionId: "mysql-1", database: "game" });
  assert.equal(first.title, "查询 1");
  store.updateDocument(first.id, { sql: "SELECT 1", dirty: true });

  const saved = JSON.parse(storage.value(SQL_QUERY_DOCUMENTS_STORAGE_KEY));
  assert.equal(saved.version, 1);
  assert.equal(saved.documents[0].sql, "SELECT 1");
  assert.equal(loadSqlQueryDocuments(storage)[0].id, first.id);
});

test("syncing an SQL tab assigns a document id and preserves file metadata", () => {
  const storage = createStorage();
  const store = createSqlQueryDocumentStore({ storage, now: () => "2026-07-15T10:00:00.000Z", createId: () => "doc-tab" });
  const tab = {
    kind: "sql",
    title: "orders.sql",
    sql: "SELECT * FROM orders",
    savedSql: "SELECT * FROM orders",
    dirty: false,
    filePath: "D:\\sql\\orders.sql",
    fileName: "orders.sql",
    connectionId: "mysql-1",
    database: "shop",
  };

  const document = store.upsertFromTab(tab);
  assert.equal(tab.documentId, "doc-tab");
  assert.equal(document.filePath, "D:\\sql\\orders.sql");
  assert.equal(store.findByFilePath("d:\\SQL\\ORDERS.SQL").id, document.id);
});

test("duplicate documents become internal drafts and sequence names ignore custom titles", () => {
  const store = createSqlQueryDocumentStore({
    storage: createStorage(),
    initialDocuments: [
      { id: "one", title: "查询 4", sql: "SELECT 4" },
      { id: "custom", title: "月度报表", sql: "SELECT 5" },
    ],
    now: () => "2026-07-15T10:00:00.000Z",
    createId: () => "copy",
  });

  assert.equal(nextSqlQueryTitle(store.documents.value), "查询 5");
  const copy = store.duplicateDocument("custom");
  assert.equal(copy.title, "月度报表 副本");
  assert.equal(copy.filePath, "");
  assert.equal(copy.dirty, true);
  assert.equal(store.removeDocument(copy.id).id, copy.id);
  assert.equal(store.findDocument(copy.id), null);
});

test("loading query documents collapses exact migration duplicates", () => {
  const storage = createStorage();
  storage.setItem(SQL_QUERY_DOCUMENTS_STORAGE_KEY, JSON.stringify({
    version: 1,
    documents: [
      { id: "old", title: "查询 1", sql: "SELECT 1", connectionId: "demo", database: "game", updatedAt: "2026-07-14T00:00:00.000Z" },
      { id: "new", title: "查询 1", sql: "SELECT 1", connectionId: "demo", database: "game", updatedAt: "2026-07-15T00:00:00.000Z" },
    ],
  }));

  const loaded = loadSqlQueryDocuments(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "new");
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  forgetRecentSqlFile,
  loadRecentSqlFiles,
  MAX_RECENT_SQL_FILES,
  rememberRecentSqlFile,
  SQL_RECENT_FILES_KEY,
} from "./utils/sqlRecentFiles.js";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("recent SQL files are deduplicated, bounded, and removable", () => {
  const storage = createStorage();
  for (let index = 0; index < MAX_RECENT_SQL_FILES + 3; index += 1) {
    rememberRecentSqlFile({ path: `C:\\queries\\query-${index}.sql`, fileName: `query-${index}.sql` }, storage);
  }
  rememberRecentSqlFile({ path: "c:\\QUERIES\\QUERY-5.SQL", fileName: "renamed.sql" }, storage);

  const recent = loadRecentSqlFiles(storage);
  assert.equal(recent.length, MAX_RECENT_SQL_FILES);
  assert.equal(recent[0].fileName, "renamed.sql");
  assert.equal(recent.filter((item) => item.path.toLocaleLowerCase().endsWith("query-5.sql")).length, 1);

  forgetRecentSqlFile(recent[0].path, storage);
  assert.equal(loadRecentSqlFiles(storage).some((item) => item.fileName === "renamed.sql"), false);
  assert.ok(storage.getItem(SQL_RECENT_FILES_KEY));
});

test("invalid recent SQL file storage degrades to an empty list", () => {
  const storage = createStorage();
  storage.setItem(SQL_RECENT_FILES_KEY, "not-json");
  assert.deepEqual(loadRecentSqlFiles(storage), []);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConnectionUrl,
  connectionCapabilities,
  connectionHasCapability,
  connectionKindBadge,
  isConnFormComplete,
  isConnTestReady,
  isReadOnlyKind,
  normalizeConnectionKind,
} from "./connectionKinds.js";

test("normalizeConnectionKind treats mongo aliases and URLs as mongodb", () => {
  assert.equal(normalizeConnectionKind("mongodb"), "mongodb");
  assert.equal(normalizeConnectionKind("mongo"), "mongodb");
  assert.equal(normalizeConnectionKind("mongodb+srv"), "mongodb");
  assert.equal(normalizeConnectionKind("", "mongodb://127.0.0.1:27017"), "mongodb");
  assert.equal(normalizeConnectionKind("", "mongodb+srv://user:pass@cluster.mongodb.net"), "mongodb");
  assert.equal(normalizeConnectionKind("clickhouse"), "clickhouse");
  assert.equal(normalizeConnectionKind("", "http://127.0.0.1:8123"), "clickhouse");
  assert.equal(normalizeConnectionKind(""), "mysql");
  assert.equal(normalizeConnectionKind("mysql", "mongodb://127.0.0.1:27017"), "mongodb");
});

test("MongoDB connections stay writable and only expose grid plus export capabilities", () => {
  assert.equal(isReadOnlyKind("mongodb"), false);
  assert.equal(connectionKindBadge("mongodb"), "Mongo");
  assert.equal(connectionKindBadge("clickhouse"), "CH");
  assert.equal(connectionKindBadge("mysql"), "MySQL");

  const caps = connectionCapabilities("mongodb");
  assert.equal(caps.gridEdit, true);
  assert.equal(caps.sqlConsole, false);
  assert.equal(caps.tableDesign, false);
  assert.equal(caps.snapshots, false);
  assert.equal(caps.sync, false);
  assert.equal(caps.tableCopy, false);
  assert.equal(caps.import, false);
  assert.equal(caps.findReplace, false);
  assert.equal(caps.renameDrop, false);
  assert.equal(connectionHasCapability("mongodb", "gridEdit"), true);
  assert.equal(connectionHasCapability("mongodb", "sqlConsole"), false);
  assert.equal(connectionHasCapability("mysql", "sqlConsole"), true);
});

test("buildConnectionUrl keeps Atlas strings and allows empty Mongo credentials", () => {
  assert.equal(
    buildConnectionUrl({
      kind: "mongodb",
      host: "mongodb+srv://user:pass@cluster.mongodb.net/game?authSource=admin",
      port: "27017",
    }),
    "mongodb+srv://user:pass@cluster.mongodb.net/game?authSource=admin",
  );
  assert.equal(
    buildConnectionUrl({ kind: "mongodb", host: "127.0.0.1", port: "27017" }),
    "mongodb://127.0.0.1:27017",
  );
  assert.equal(
    buildConnectionUrl({
      kind: "mongodb",
      host: "127.0.0.1",
      port: "27017",
      username: "root",
      password: "s ecret",
    }),
    "mongodb://root:s%20ecret@127.0.0.1:27017",
  );
});

test("Mongo connection form does not require username or password", () => {
  assert.equal(isConnFormComplete({ kind: "mongodb", host: "127.0.0.1", port: "27017" }), true);
  assert.equal(isConnTestReady({ kind: "mongodb", host: "127.0.0.1", port: "27017" }), true);
  assert.equal(isConnFormComplete({ kind: "mongodb", host: "mongodb://127.0.0.1:27017" }), true);
  assert.equal(isConnFormComplete({ kind: "mysql", host: "127.0.0.1", port: "3306" }), false);
  assert.equal(isConnTestReady({ kind: "mysql", host: "127.0.0.1", port: "3306", username: "root" }), false);
});

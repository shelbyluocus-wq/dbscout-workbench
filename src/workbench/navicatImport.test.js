import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import {
  annotateNavicatCandidates,
  buildImportedConnectionRecord,
  hasConnectableCredentials,
  injectPasswordIntoConnectionUrl,
  isNavicatNcxFileName,
  navicatConnectionKey,
} from "./utils/navicatImport.js";

function createMemoryStorage() {
  const store = new Map();
  return {
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

test("detects .ncx filenames case-insensitively", () => {
  assert.equal(isNavicatNcxFileName("connections.ncx"), true);
  assert.equal(isNavicatNcxFileName("BACKUP.NCX"), true);
  assert.equal(isNavicatNcxFileName("config.json"), false);
});

test("annotates Navicat candidates with duplicate detection and filters non-MySQL/MongoDB entries", () => {
  const candidates = [
    {
      id: "registry:mysql:0",
      name: "线上配置库",
      kind: "mysql",
      host: "192.168.1.223",
      port: "8306",
      username: "root",
      password: "secret",
      passwordStatus: "decrypted",
    },
    {
      id: "registry:mysql:dup",
      name: "重复条目",
      kind: "mysql",
      host: "192.168.1.223",
      port: "8306",
      username: "root",
      password: "secret",
      passwordStatus: "decrypted",
    },
    {
      id: "registry:mongodb:1",
      name: "本地 Mongo",
      kind: "mongodb",
      host: "127.0.0.1",
      port: "27017",
      username: "",
      password: "",
      passwordStatus: "empty",
    },
    {
      id: "registry:clickhouse:2",
      name: "忽略 ClickHouse",
      kind: "clickhouse",
      host: "10.0.0.99",
      port: "8123",
      username: "default",
      password: "pw",
    },
  ];

  const existingConnections = [
    { id: "mongo-1", kind: "mongodb", host: "127.0.0.1", port: "27017", username: "", connected: true },
  ];

  const annotated = annotateNavicatCandidates(candidates, existingConnections, []);
  assert.equal(annotated.length, 3);
  assert.equal(annotated[0].alreadyExists, false);
  assert.equal(annotated[0].defaultSelected, true);
  assert.equal(annotated[0].addressLabel, "root@192.168.1.223:8306");

  assert.equal(annotated[1].duplicateInBatch, true);
  assert.equal(annotated[1].defaultSelected, false);

  assert.equal(annotated[2].alreadyExists, true);
  assert.equal(annotated[2].existingConnectionId, "mongo-1");
  assert.equal(annotated[2].defaultSelected, false);
});

test("builds imported connection records and preserves MongoDB URI query parameters", () => {
  const mongoRecord = buildImportedConnectionRecord(
    {
      name: "日志集群",
      kind: "mongodb",
      host: "10.0.0.8",
      port: "27018",
      username: "admin",
      password: "",
      database: "game_log",
      url: "mongodb://admin@10.0.0.8:27018/game_log?authSource=admin&replicaSet=rs0",
    },
    { passwordOverride: "p@ss/1" },
  );

  assert.equal(mongoRecord.kind, "mongodb");
  assert.equal(mongoRecord.alias, "日志集群");
  assert.equal(mongoRecord.host, "10.0.0.8");
  assert.equal(mongoRecord.port, "27018");
  assert.equal(mongoRecord.url, "mongodb://admin:p%40ss%2F1@10.0.0.8:27018/game_log?authSource=admin&replicaSet=rs0");
  assert.equal(navicatConnectionKey(mongoRecord), "mongodb:10.0.0.8:27018:admin");
  assert.equal(hasConnectableCredentials(mongoRecord), true);

  const missingMySql = buildImportedConnectionRecord({
    name: "无密码 MySQL",
    kind: "mysql",
    host: "10.0.0.9",
    port: "3306",
    username: "root",
    password: "",
  });
  assert.equal(hasConnectableCredentials(missingMySql), false);
  assert.equal(
    injectPasswordIntoConnectionUrl("mongodb+srv://user@cluster.example.net/db?tls=true", { password: "abc" }),
    "mongodb+srv://user:abc@cluster.example.net/db?tls=true",
  );
});

test("useConnection.importNavicatConnections saves, aliases, and restores imported MySQL and MongoDB connections", async () => {
  const storage = createMemoryStorage();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;

  try {
    const { useConnection } = await import("./composables/useConnection.js");
    const workspace = reactive({
      connectionId: "",
      database: "",
      tables: [],
      schema: [],
    });

    const runtimeConnections = [];
    const restoreCalls = [];

    async function invokeWorkbench(command, payload = {}) {
      if (command === "list_connections") {
        return runtimeConnections.map((item) => ({ ...item }));
      }
      if (command === "restore_connection") {
        restoreCalls.push(payload);
        if (payload.url.includes("10.0.0.99")) {
          throw new Error("connection refused");
        }
        const id = `${payload.kind}-${runtimeConnections.length + 1}`;
        const parsed = new URL(payload.url);
        runtimeConnections.push({
          id,
          kind: payload.kind,
          label: id,
          host: payload.kind === "mysql" ? "configured" : parsed.hostname,
          port: Number(parsed.port || (payload.kind === "mongodb" ? 27017 : 3306)),
          username: decodeURIComponent(parsed.username || ""),
          database: null,
          connected: true,
          readOnly: false,
        });
        return ["game_db"];
      }
      if (command === "list_databases") {
        return ["game_db"];
      }
      if (command === "list_tables") {
        return [];
      }
      return [];
    }

    const conn = useConnection(workspace, invokeWorkbench);
    await conn.loadConnections();

    const summary = await conn.importNavicatConnections([
      {
        name: "线上配置库",
        kind: "mysql",
        host: "192.168.1.223",
        port: "8306",
        username: "root",
        password: "secret",
        database: "game_db",
      },
      {
        name: "未保存密码库",
        kind: "mysql",
        host: "10.0.0.50",
        port: "3306",
        username: "dev",
        password: "",
      },
      {
        name: "游戏日志 Mongo",
        kind: "mongodb",
        host: "10.0.0.25",
        port: "27017",
        username: "admin",
        password: "mongo_pwd",
        url: "mongodb://admin:mongo_pwd@10.0.0.25:27017/?authSource=admin",
      },
      {
        name: "离线库",
        kind: "mysql",
        host: "10.0.0.99",
        port: "3306",
        username: "root",
        password: "secret",
      },
    ]);

    assert.equal(summary.added, 4);
    assert.equal(summary.updated, 0);

    // Wait for sequential background restore to complete.
    await conn.whenConnectionsRestored();

    // Missing-password MySQL was saved as a placeholder without firing a failing restore call.
    assert.equal(restoreCalls.length, 3);
    assert.equal(restoreCalls[1].url, "mongodb://admin:mongo_pwd@10.0.0.25:27017/?authSource=admin");

    const mysqlLive = conn.connections.value.find((item) => item.host === "192.168.1.223");
    assert.ok(mysqlLive?.connected);
    assert.equal(conn.getConnectionAlias(mysqlLive.id), "线上配置库");

    const mongoLive = conn.connections.value.find((item) => item.host === "10.0.0.25");
    assert.ok(mongoLive?.connected);
    assert.equal(conn.getConnectionAlias(mongoLive.id), "游戏日志 Mongo");

    const noPassPlaceholder = conn.connections.value.find((item) => item.host === "10.0.0.50");
    assert.ok(noPassPlaceholder);
    assert.equal(noPassPlaceholder.connected, false);
    assert.equal(conn.getConnectionAlias(noPassPlaceholder.id), "未保存密码库");

    const offlinePlaceholder = conn.connections.value.find((item) => item.host === "10.0.0.99");
    assert.ok(offlinePlaceholder);
    assert.equal(offlinePlaceholder.connected, false);
    assert.equal(conn.getConnectionAlias(offlinePlaceholder.id), "离线库");

    const saved = conn.listSavedConnections();
    assert.equal(saved.length, 4);
    assert.equal(saved.find((item) => item.host === "10.0.0.25")?.url, "mongodb://admin:mongo_pwd@10.0.0.25:27017/?authSource=admin");

    conn.dispose();
  } finally {
    globalThis.localStorage = previousLocalStorage;
  }
});

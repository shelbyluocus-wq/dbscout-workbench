import test from "node:test";
import assert from "node:assert/strict";
import { parseConnectionConfigText } from "./utils/connectionConfigImport.js";

test("parses flat MySQL JSON config with user alias and database", () => {
  const parsed = parseConnectionConfigText(
    `{
      "host": "192.168.1.223",
      "port": 8306,
      "database": "edota_3cfg",
      "user": "root",
      "password": "-4md.f0J>USm>n?M)f^fTBU4-",
      "language": "cn"
    }`,
    { fileName: "propcfg.json" },
  );

  assert.deepEqual(parsed.config, {
    kind: "mysql",
    host: "192.168.1.223",
    port: "8306",
    username: "root",
    password: "-4md.f0J>USm>n?M)f^fTBU4-",
    database: "edota_3cfg",
  });
  assert.deepEqual(parsed.fields.sort(), ["database", "host", "password", "port", "username"].sort());
});

test("parses nested config aliases without taking unrelated top-level values", () => {
  const parsed = parseConnectionConfigText(
    JSON.stringify({
      language: "cn",
      prod: {
        dbHost: "db.internal",
        dbPort: "3307",
        dbUser: "game_admin",
        dbPassword: "secret",
        dbName: "game_prod",
      },
    }),
  );

  assert.deepEqual(parsed.config, {
    kind: "mysql",
    host: "db.internal",
    port: "3307",
    username: "game_admin",
    password: "secret",
    database: "game_prod",
  });
});

test("parses mysql connection URLs and decodes credentials", () => {
  const parsed = parseConnectionConfigText(
    JSON.stringify({
      connectionUrl: "mysql://game%20user:p%40ss%3Aword@db.example.com:3308/game_cfg?charset=utf8mb4",
    }),
  );

  assert.deepEqual(parsed.config, {
    kind: "mysql",
    host: "db.example.com",
    port: "3308",
    username: "game user",
    password: "p@ss:word",
    database: "game_cfg",
  });
});

test("parses MongoDB connection URLs and keeps the full string as host", () => {
  const parsed = parseConnectionConfigText(
    JSON.stringify({
      kind: "mongo",
      mongodbUrl: "mongodb+srv://game%20user:p%40ss@cluster.mongodb.net/game_cfg?authSource=admin",
    }),
  );

  assert.equal(parsed.config.kind, "mongodb");
  assert.equal(parsed.config.host, "mongodb+srv://game%20user:p%40ss@cluster.mongodb.net/game_cfg?authSource=admin");
  assert.equal(parsed.config.port, "27017");
  assert.equal(parsed.config.username, "game user");
  assert.equal(parsed.config.password, "p@ss");
  assert.equal(parsed.config.database, "game_cfg");
});

test("rejects JSON that does not contain a usable connection host", () => {
  assert.throws(
    () => parseConnectionConfigText(JSON.stringify({ language: "cn", retries: 3 })),
    /没有识别到数据库连接信息/,
  );
});

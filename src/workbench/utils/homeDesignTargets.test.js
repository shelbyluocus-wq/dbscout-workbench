import test from "node:test";
import assert from "node:assert/strict";

import { resolveHomeDesignTargets } from "./homeDesignTargets.js";

test("returns every selected table in selection order", () => {
  const targets = resolveHomeDesignTargets({
    connectionId: "conn-1",
    database: "game_db",
    selectedTableNames: ["player", "guild", "audit"],
    focusedTableName: "guild",
  });
  assert.deepEqual(targets, [
    { connectionId: "conn-1", database: "game_db", tableName: "player" },
    { connectionId: "conn-1", database: "game_db", tableName: "guild" },
    { connectionId: "conn-1", database: "game_db", tableName: "audit" },
  ]);
});

test("falls back to the focused table when nothing is selected", () => {
  const targets = resolveHomeDesignTargets({
    connectionId: "conn-1",
    database: "game_db",
    selectedTableNames: [],
    focusedTableName: "player",
  });
  assert.deepEqual(targets, [
    { connectionId: "conn-1", database: "game_db", tableName: "player" },
  ]);
});

test("dedupes case-insensitively and drops empty names", () => {
  const targets = resolveHomeDesignTargets({
    connectionId: "conn-1",
    database: "game_db",
    selectedTableNames: ["Player", "player", " ", "PLAYER"],
  });
  assert.deepEqual(targets, [
    { connectionId: "conn-1", database: "game_db", tableName: "Player" },
  ]);
});

test("returns an empty list when there is no selection and no focus", () => {
  assert.deepEqual(resolveHomeDesignTargets({ connectionId: "c", database: "d" }), []);
  assert.deepEqual(resolveHomeDesignTargets(null), []);
});

test("accepts snake_case connection ids", () => {
  const targets = resolveHomeDesignTargets({
    connection_id: "conn-2",
    database: "db",
    selectedTableNames: ["t"],
  });
  assert.equal(targets[0].connectionId, "conn-2");
});

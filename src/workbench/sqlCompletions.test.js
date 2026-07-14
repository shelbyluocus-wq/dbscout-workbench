import test from "node:test";
import assert from "node:assert/strict";

import { buildSqlCompletionOptions } from "./utils/sqlCompletions.js";

test("SQL completion options prioritize keywords and include database schema names", () => {
  const options = buildSqlCompletionOptions([
    {
      table_name: "hero",
      columns: [{ column_name: "hero_id" }, { name: "display_name" }],
    },
  ], ["game_db"]);

  assert.deepEqual(options[0], { label: "SELECT", type: "keyword" });
  assert.equal(options.some((item) => item.label === "COUNT" && item.type === "function"), true);
  assert.equal(options.some((item) => item.label === "game_db" && item.detail === "数据库"), true);
  assert.equal(options.some((item) => item.label === "hero" && item.detail === "表"), true);
  assert.equal(options.some((item) => item.label === "hero_id" && item.detail === "hero"), true);
  assert.equal(options.some((item) => item.label === "display_name" && item.detail === "hero"), true);
});

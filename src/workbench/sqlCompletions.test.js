import test from "node:test";
import assert from "node:assert/strict";

import { buildSqlCompletionOptions, getSqlCompletionContext } from "./utils/sqlCompletions.js";

const schema = [
  {
    table_name: "hero",
    table_comment: "英雄配置表",
    columns: [
      { column_name: "hero_id", column_type: "int", column_comment: "英雄ID", is_primary_key: true },
      { name: "display_name", column_type: "varchar(64)", column_comment: "显示名称" },
    ],
  },
  {
    table_name: "skill",
    columns: [
      { column_name: "skill_id", column_type: "int" },
      { column_name: "hero_id", column_type: "int" },
    ],
  },
];

function complete(sql, databases = ["game_db"]) {
  const context = getSqlCompletionContext(sql, sql.length);
  return { context, options: buildSqlCompletionOptions(schema, databases, context) };
}

test("SQL completion offers safe starter templates and command keywords", () => {
  const { context, options } = complete("SEL");

  assert.equal(context.kind, "statement");
  assert.equal(context.from, 0);
  assert.equal(options[0].displayLabel, "SELECT ... FROM ...");
  assert.equal(options[0].boost > options[1].boost, true);
  assert.equal(options.some((item) => item.displayLabel === "SELECT ... FROM ..." && item.template.includes("LIMIT")), true);
  assert.equal(options.some((item) => item.label === "SELECT" && item.type === "keyword"), true);
});

test("relation clauses prioritize tables and databases instead of unrelated fields", () => {
  const { context, options } = complete("SELECT * FROM he");

  assert.equal(context.kind, "relation");
  assert.equal(context.prefix, "he");
  assert.equal(options.some((item) => item.label === "hero" && item.detail === "表"), true);
  assert.equal(options.some((item) => item.label === "game_db" && item.detail === "数据库"), true);
  assert.equal(options.some((item) => item.label === "hero_id"), false);
});

test("qualified aliases only offer columns from the referenced table", () => {
  const sql = "SELECT h. FROM hero AS h";
  const cursor = sql.indexOf(".") + 1;
  const context = getSqlCompletionContext(sql, cursor);
  const options = buildSqlCompletionOptions(schema, ["game_db"], context);

  assert.equal(context.kind, "qualified");
  assert.equal(context.qualifier, "h");
  assert.deepEqual(options.map((item) => item.label), ["hero_id", "display_name"]);
  assert.equal(options[0].detail, "h · int");
  assert.match(options[0].info, /主键/);
});

test("database qualifiers offer current schema tables", () => {
  const { context, options } = complete("SELECT * FROM game_db.");
  context.database = "game_db";
  const scopedOptions = buildSqlCompletionOptions(schema, ["game_db"], context);

  assert.equal(context.kind, "qualified");
  assert.equal(context.qualifier, "game_db");
  assert.equal(options.length, 0, "unscoped database metadata must not be guessed");
  assert.deepEqual(scopedOptions.map((item) => item.label), ["hero", "skill"]);
});

test("expression completion prioritizes referenced columns and qualifies multi-table fields", () => {
  const { context, options } = complete("SELECT * FROM hero h JOIN skill s ON ");

  assert.equal(context.kind, "expression");
  assert.equal(options.some((item) => item.label === "h.hero_id" && item.section.name === "当前语句"), true);
  assert.equal(options.some((item) => item.label === "s.skill_id" && item.section.name === "当前语句"), true);
  assert.equal(options.some((item) => item.label === "COUNT" && item.type === "function"), true);
});

test("completion stays closed inside SQL strings and comments", () => {
  const stringContext = getSqlCompletionContext("SELECT 'FROM hero", 17);
  const commentContext = getSqlCompletionContext("SELECT * -- FROM hero", 21);

  assert.equal(stringContext.kind, "blocked");
  assert.equal(commentContext.kind, "blocked");
  assert.deepEqual(buildSqlCompletionOptions(schema, [], stringContext), []);
});

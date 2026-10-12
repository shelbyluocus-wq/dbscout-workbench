import assert from "node:assert/strict";
import test from "node:test";
import { createTableMentionIndex, splitTableMentions } from "./tableMentions.js";

const tables = [
  { table_name: "hero", table_comment: "英雄配置表", connectionId: "demo", database: "game_db" },
  { table_name: "user", table_comment: "用户", connectionId: "demo", database: "game_db" },
  { table_name: "users", table_comment: "用户们", connectionId: "demo", database: "game_db" },
  { table_name: "drop_table", table_comment: "掉落", connectionId: "demo", database: "game_db" },
  { table_name: "skill", table_comment: "技能", connectionId: "other", database: "game_db" },
];

test("only tables in the current database become links", () => {
  const index = createTableMentionIndex(tables, { connectionId: "demo", database: "game_db" });
  assert.equal(index.has("skill"), false);
  assert.equal(index.get("hero").name, "hero");
  assert.equal(index.get("hero").comment, "英雄配置表");

  const parts = splitTableMentions("名称字段：user 与 users.ID，另见 skill", index);
  assert.deepEqual(parts.map((part) => part.table?.name || part.text), [
    "名称字段：",
    "user",
    " 与 ",
    "users",
    ".ID，另见 skill",
  ]);
});

test("a longer identifier does not link a shorter table name", () => {
  const index = createTableMentionIndex(tables, { connectionId: "demo", database: "game_db" });
  assert.equal(splitTableMentions("username 和 drop_table_id", index), null);
  assert.equal(splitTableMentions("对应 drop_table.ID", index)[1].table.name, "drop_table");
});

test("matching keeps the written case and opens the real table name", () => {
  const index = createTableMentionIndex([{ table_name: "Hero", table_comment: "英雄" }]);
  const parts = splitTableMentions("引用 hero.ID", index);
  assert.equal(parts[1].text, "hero");
  assert.equal(parts[1].table.name, "Hero");
});

test("text without a current table stays plain", () => {
  const index = createTableMentionIndex(tables, { connectionId: "demo", database: "game_db" });
  assert.equal(splitTableMentions("", index), null);
  assert.equal(splitTableMentions("炎龙骑士", index), null);
  assert.equal(splitTableMentions("hero", createTableMentionIndex([])), null);
});

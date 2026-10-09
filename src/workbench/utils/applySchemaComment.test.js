import test from "node:test";
import assert from "node:assert/strict";
import { applySchemaComment } from "./applySchemaComment.js";
import { mockWorkbenchInvoke } from "../mock/mockBackend.js";

test("saving a field comment changes only that comment", async () => {
  const applied = [];
  const outcome = await applySchemaComment(
    async (command, payload) => {
      if (command === "apply_table_design_change") {
        applied.push(payload);
        return { applied: true, schema: { table_name: payload.tableName, table_comment: payload.draft.tableComment, columns: payload.draft.columns } };
      }
      return mockWorkbenchInvoke(command, payload);
    },
    { connectionId: "", database: "game_db", tableName: "player" },
    { kind: "column", columnName: "nickname" },
    "玩家昵称",
  );

  assert.equal(outcome.status, "applied");
  assert.equal(applied.length, 1);
  const nickname = applied[0].draft.columns.find((column) => column.name === "nickname");
  const username = applied[0].draft.columns.find((column) => column.name === "username");
  assert.equal(nickname.comment, "玩家昵称");
  assert.equal(username.comment, "用户名");
  assert.equal(applied[0].draft.tableComment, "玩家账号表");
  assert.match(outcome.preview.statements.join("\n"), /nickname/);
  assert.equal(outcome.preview.statements.length, 1);
  assert.ok(applied[0].previewSignature);
  assert.ok(applied[0].schemaSignature);
});

test("saving the same comment does not write", async () => {
  const commands = [];
  const outcome = await applySchemaComment(
    async (command, payload) => {
      commands.push(command);
      return mockWorkbenchInvoke(command, payload);
    },
    { tableName: "player" },
    { kind: "column", columnName: "nickname" },
    "昵称",
  );
  assert.equal(outcome.status, "unchanged");
  assert.deepEqual(commands, ["get_table_design"]);
});

test("saving a table comment leaves field comments untouched", async () => {
  const applied = [];
  const outcome = await applySchemaComment(
    async (command, payload) => {
      if (command === "apply_table_design_change") {
        applied.push(payload);
        return { applied: true, schema: payload.draft };
      }
      return mockWorkbenchInvoke(command, payload);
    },
    { tableName: "player" },
    { kind: "table" },
    "账号主表",
  );
  assert.equal(outcome.status, "applied");
  assert.equal(applied[0].draft.tableComment, "账号主表");
  assert.equal(applied[0].draft.columns.find((column) => column.name === "nickname").comment, "昵称");
  assert.equal(outcome.preview.statements.length, 1);
  assert.match(outcome.preview.statements[0], /COMMENT/);
});

test("a missing field is reported without writing", async () => {
  const commands = [];
  const outcome = await applySchemaComment(
    async (command, payload) => {
      commands.push(command);
      return mockWorkbenchInvoke(command, payload);
    },
    { tableName: "player" },
    { kind: "column", columnName: "missing_field" },
    "新备注",
  );
  assert.deepEqual(outcome, { status: "missing-column", columnName: "missing_field" });
  assert.deepEqual(commands, ["get_table_design"]);
});

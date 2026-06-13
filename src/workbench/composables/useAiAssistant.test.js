import test from "node:test";
import assert from "node:assert/strict";

import { useAiAssistant } from "./useAiAssistant.js";

function createWorkspace() {
  return {
    connectionId: "demo",
    database: "game_db",
  };
}

function createActiveTab() {
  return {
    id: "tab-player",
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    tableComment: "玩家账号表",
    columns: [
      { column_name: "id", column_type: "bigint", column_comment: "主键", is_primary_key: true },
      { column_name: "username", column_type: "varchar(64)", column_comment: "用户名", is_primary_key: false },
    ],
    rows: [{ id: "1", username: "alice" }],
    totalRows: 42,
  };
}

test("send blocks AI requests until the user provides an API key", async () => {
  const assistant = useAiAssistant(createWorkspace(), async () => {
    throw new Error("invoke should not run without a key");
  });

  assistant.draft.value = "这个表是做什么的？";
  await assistant.send(createActiveTab());

  assert.equal(assistant.status.value, "error");
  assert.match(assistant.error.value, /API Key/);
  assert.equal(assistant.messages.value.length, 0);
});

test("send invokes the assistant command with current database context and appends the reply", async () => {
  let observed = null;
  const assistant = useAiAssistant(createWorkspace(), async (command, payload) => {
    observed = { command, payload };
    return {
      answer: "player 表保存玩家账号。",
      toolResults: [
        {
          name: "search_schema",
          title: "Search schema",
          summary: "检索结构: 1 个候选",
          detail: "query: 英雄; candidates: heroprop",
          status: "completed",
        },
      ],
    };
  });

  assistant.apiKey.value = "sk-test";
  assistant.apiUrl.value = "https://proxy.example.com/v1/responses";
  assistant.model.value = "gpt-5.5";
  assistant.draft.value = "解释当前表";
  await assistant.send(createActiveTab());

  assert.equal(observed.command, "ask_database_assistant");
  assert.deepEqual(observed.payload.context, {
    connectionId: "demo",
    database: "game_db",
    activeTableName: "player",
  });
  assert.equal(observed.payload.request.question, "解释当前表");
  assert.equal(observed.payload.request.apiKey, "sk-test");
  assert.equal(observed.payload.request.apiUrl, "https://proxy.example.com/v1/responses");
  assert.equal(observed.payload.request.model, "gpt-5.5");
  assert.deepEqual(observed.payload.request.messages, []);
  assert.equal(assistant.messages.value.at(-1).role, "assistant");
  assert.equal(assistant.messages.value.at(-1).content, "player 表保存玩家账号。");
  assert.deepEqual(assistant.messages.value.at(-1).toolResults, [
    {
      name: "search_schema",
      title: "Search schema",
      summary: "检索结构: 1 个候选",
      detail: "query: 英雄; candidates: heroprop",
      status: "completed",
    },
  ]);
  assert.equal(assistant.draft.value, "");
  assert.equal(assistant.status.value, "idle");
});

test("new sessions archive active messages and history can restore them", () => {
  const assistant = useAiAssistant(createWorkspace(), async () => {
    throw new Error("invoke is not needed for session history");
  });

  assistant.messages.value = [
    { id: "u1", role: "user", content: "show me user growth", toolResults: [] },
    { id: "a1", role: "assistant", content: "User growth is up.", toolResults: [] },
  ];
  assistant.draft.value = "unfinished";
  assistant.error.value = "old error";
  assistant.status.value = "error";

  assistant.startNewSession();

  assert.equal(assistant.messages.value.length, 0);
  assert.equal(assistant.draft.value, "");
  assert.equal(assistant.error.value, "");
  assert.equal(assistant.status.value, "idle");
  assert.equal(assistant.sessionHistory.value.length, 1);
  assert.equal(assistant.sessionHistory.value[0].title, "show me user growth");

  const archivedId = assistant.sessionHistory.value[0].id;
  assistant.restoreSession(archivedId);

  assert.equal(assistant.messages.value.length, 2);
  assert.equal(assistant.messages.value[0].content, "show me user growth");
  assert.equal(assistant.messages.value[1].content, "User growth is up.");
});

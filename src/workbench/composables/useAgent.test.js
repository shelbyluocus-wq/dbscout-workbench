import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";
import { useAgent } from "./useAgent.js";
import { emitMockEvent } from "../mock/mockEventBus.js";

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installMemoryStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

describe("useAgent", () => {
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it("treats first-run config as complete so bundled credentials can start without onboarding", () => {
    const agent = useAgent({}, async () => null);

    assert.equal(agent.onboardingComplete.value, true);
    assert.equal(agent.apiKey.value, "");
    assert.equal(agent.apiUrl.value, "");
    assert.equal(agent.model.value, "");
  });

  it("starts a session on first send and appends streaming text deltas", async () => {
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") return "started";
      return null;
    };

    const workspace = { connectionId: "demo", database: "game_db" };
    const agent = useAgent(workspace, invokeWorkbench);

    agent.draft.value = "hello";
    const sendPromise = agent.send({ connectionId: "demo", database: "game_db", tableName: "player" });
    await flushPromises();

    assert.equal(invocations[0].command, "agent_start_session");

    emitMockEvent("agent-event", { ev: "system_init", sessionId: "sess-1", model: "claude-test" });
    emitMockEvent("agent-event", { ev: "text_delta", text: "Hello " });
    emitMockEvent("agent-event", { ev: "text_delta", text: "world" });
    emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0.01, isError: false, text: "Hello world" });

    await sendPromise;
    await flushPromises();
    await nextTick();

    assert.equal(agent.messages.value.length, 2);
    assert.equal(agent.messages.value[0].role, "user");
    assert.equal(agent.messages.value[0].content, "hello");
    assert.equal(agent.messages.value[1].role, "assistant");
    assert.equal(agent.messages.value[1].content, "Hello world");
    assert.equal(agent.messages.value[1].done, true);
    assert.equal(agent.status.value, "idle");
  });

  it("records the active database and table label on user messages", async () => {
    const tableAgent = useAgent({ connectionId: "demo", database: "game_db" }, async () => null);

    tableAgent.draft.value = "describe table";
    await tableAgent.send({ connectionId: "demo", database: "game_db", tableName: "player" });

    assert.equal(tableAgent.messages.value[0].contextLabel, "game_db.player");

    const databaseAgent = useAgent({ connectionId: "demo", database: "game_db" }, async () => null);
    databaseAgent.draft.value = "describe database";
    await databaseAgent.send({ connectionId: "demo", database: "game_db" });

    assert.equal(databaseAgent.messages.value[0].contextLabel, "game_db");
  });

  it("records assistant start and completion timing from live events", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "hello";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "text_delta", text: "Hello" });
    const assistant = agent.messages.value[1];

    assert.equal(typeof assistant.startedAt, "number");
    assert.equal(assistant.completedAt, undefined);
    assert.equal(assistant.elapsedMs, undefined);

    emitMockEvent("agent-event", { ev: "result", subtype: "success", text: "Hello" });
    await flushPromises();
    await nextTick();

    assert.equal(assistant.done, true);
    assert.equal(typeof assistant.completedAt, "number");
    assert.ok(assistant.completedAt >= assistant.startedAt);
    assert.equal(assistant.elapsedMs, assistant.completedAt - assistant.startedAt);
  });

  it("completes an in-progress assistant message when approval is requested", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "update row";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "tool_use", id: "tu-1", name: "run_write_query", input: { sql: "UPDATE player SET level = 2" } });
    const assistant = agent.messages.value[1];
    assert.equal(typeof assistant.startedAt, "number");

    emitMockEvent("agent-event", {
      ev: "approval_request",
      req_id: "approval-1",
      toolName: "mcp__dbscout-db__run_write_query",
      input: { sql: "UPDATE player SET level = 2" },
    });
    await flushPromises();
    await nextTick();

    assert.equal(assistant.done, true);
    assert.equal(typeof assistant.completedAt, "number");
    assert.equal(assistant.elapsedMs, assistant.completedAt - assistant.startedAt);
  });

  it("passes authToken through start config without requiring an apiKey", async () => {
    const invocations = [];
    const agent = useAgent({}, async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") return "started";
      return null;
    });

    agent.authToken.value = "managed-auth-token";
    agent.draft.value = "hello";
    await agent.send();

    const start = invocations.find((invocation) => invocation.command === "agent_start_session");
    assert.ok(start);
    assert.equal(start.payload.config.apiKey, undefined);
    assert.equal(start.payload.config.authToken, "managed-auth-token");
  });

  it("can complete onboarding without an apiKey while preserving custom config", () => {
    const store = installMemoryStorage();
    const agent = useAgent({}, async () => null);

    agent.apiUrl.value = "https://proxy.example.com";
    agent.model.value = "claude-test";
    agent.completeOnboarding();

    assert.equal(agent.onboardingComplete.value, true);
    assert.equal(agent.apiUrl.value, "https://proxy.example.com");
    assert.equal(agent.model.value, "claude-test");

    const saved = JSON.parse(store.get("dbscout-agent-config"));
    assert.equal(saved.apiUrl, "https://proxy.example.com");
    assert.equal(saved.model, "claude-test");
    assert.equal(saved.apiKey, "");
  });

  it("returns to app configuration when local Claude authentication is unavailable", async () => {
    const agent = useAgent({}, async (command) => {
      if (command === "agent_start_session") return "started";
      return null;
    });

    agent.draft.value = "hello";
    await agent.send();
    emitMockEvent("agent-event", {
      ev: "auth_required",
      message: "请在助手设置中填写 API Key 和请求地址",
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.onboardingComplete.value, false);
    assert.equal(agent.status.value, "idle");
    assert.equal(agent.error.value, "请在助手设置中填写 API Key 和请求地址");
    assert.equal(agent.draft.value, "hello");
  });

  it("keeps the configuration screen open while API fields are being edited", async () => {
    installMemoryStorage();
    const agent = useAgent({}, async () => null);

    agent.onboardingComplete.value = false;
    agent.apiUrl.value = "https://proxy.example.com";
    agent.apiKey.value = "sk-test";
    await nextTick();

    assert.equal(agent.onboardingComplete.value, false);

    agent.completeOnboarding();
    assert.equal(agent.onboardingComplete.value, true);
  });

  it("emits thinking deltas into the active assistant message", async () => {
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    };

    const agent = useAgent({}, invokeWorkbench);
    agent.draft.value = "think";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "system_init", sessionId: "sess-2" });
    emitMockEvent("agent-event", { ev: "thinking_delta", text: "Hmm..." });
    emitMockEvent("agent-event", { ev: "text_delta", text: "Done" });
    emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "Done" });

    await flushPromises();
    await nextTick();

    const assistant = agent.messages.value[1];
    assert.equal(assistant.thinking, "Hmm...");
    assert.equal(assistant.content, "Done");
  });

  it("records error events", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "x";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "error", message: "Sidecar failed" });
    await flushPromises();
    await nextTick();

    assert.equal(agent.status.value, "error");
    assert.equal(agent.error.value, "Sidecar failed");
  });

  it("queues workbench open-table actions from sidecar events", async () => {
    const agent = useAgent({}, async () => null);
    await agent.prewarm();
    emitMockEvent("agent-event", {
      ev: "workbench_action",
      requestId: "action-1",
      action: "open_table",
      connectionId: "demo",
      database: "game_db",
      tableName: "hero",
      tableComment: "英雄表",
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.pendingWorkbenchActions.value.length, 1);
    assert.deepEqual(agent.pendingWorkbenchActions.value[0], {
      requestId: "action-1",
      action: "open_table",
      connectionId: "demo",
      database: "game_db",
      tableName: "hero",
      tableComment: "英雄表",
    });

    agent.markWorkbenchActionHandled("action-1");

    assert.equal(agent.pendingWorkbenchActions.value.length, 0);
  });

  it("queues workbench focus actions from sidecar events", async () => {
    const agent = useAgent({}, async () => null);
    await agent.prewarm();
    emitMockEvent("agent-event", {
      ev: "workbench_action",
      requestId: "action-cell",
      action: "focus_cell",
      connectionId: "demo",
      database: "game_db",
      tableName: "player",
      columnName: "username",
      rowKey: "id=1",
      rowIdentity: { id: "1" },
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.pendingWorkbenchActions.value.length, 1);
    assert.deepEqual(agent.pendingWorkbenchActions.value[0], {
      requestId: "action-cell",
      action: "focus_cell",
      connectionId: "demo",
      database: "game_db",
      tableName: "player",
      tableComment: "",
      columnName: "username",
      rowKey: "id=1",
      rowIdentity: { id: "1" },
    });
  });

  it("keeps startup progress hidden while the first message starts the sidecar", async () => {
    let resolveStart;
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") {
        return new Promise((resolve) => {
          resolveStart = () => resolve("started");
        });
      }
      return null;
    };

    const agent = useAgent({ connectionId: "demo", database: "game_db" }, invokeWorkbench);
    agent.draft.value = "hello";
    const sendPromise = agent.send({ connectionId: "demo", database: "game_db", tableName: "player" });
    await flushPromises();

    assert.equal(agent.status.value, "thinking");
    assert.equal(agent.isStarting.value, false);
    assert.equal(agent.startupProgress.value.visible, false);
    assert.equal(agent.startupProgress.value.percent, 0);

    emitMockEvent("agent-event", {
      ev: "startup_progress",
      stage: "runtime",
      message: "正在加载本地运行时",
      progress: 42,
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.status.value, "thinking");
    assert.equal(agent.isStarting.value, false);
    assert.equal(agent.startupProgress.value.visible, false);
    assert.equal(agent.startupProgress.value.percent, 0);

    resolveStart();
    await sendPromise;
    await flushPromises();
    await nextTick();

    assert.deepEqual(invocations.map((invocation) => invocation.command), ["agent_start_session", "agent_send"]);
    assert.equal(agent.startupProgress.value.visible, false);
  });

  it("sends the first user message immediately after starting the sidecar", async () => {
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") return "started";
      return null;
    };

    const agent = useAgent({ connectionId: "demo", database: "game_db" }, invokeWorkbench);
    agent.draft.value = "hello";
    const sendPromise = agent.send({ connectionId: "demo", database: "game_db", tableName: "player" });
    await flushPromises();

    assert.equal(invocations[0].command, "agent_start_session");
    assert.equal(invocations[1].command, "agent_send");
    assert.deepEqual(invocations.map((inv) => inv.command), ["agent_start_session", "agent_send"]);

    emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
    await sendPromise;
  });

  it("includes schema summary in the start session context", async () => {
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") return "started";
      return null;
    };

    const workspace = {
      connectionId: "demo",
      database: "game_db",
      schema: [
        {
          table_name: "player",
          table_comment: "玩家账号表",
          columns: [
            { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false, column_comment: "玩家ID" },
            { column_name: "username", column_type: "varchar(32)", is_nullable: false, column_comment: "用户名" },
          ],
        },
      ],
    };
    const agent = useAgent(workspace, invokeWorkbench);
    agent.draft.value = "hello";
    agent.send();
    await flushPromises();

    assert.equal(invocations[0].command, "agent_start_session");
    const context = invocations[0].payload.context;
    assert.equal(context.connectionId, "demo");
    assert.equal(context.database, "game_db");
    assert.match(context.schemaSummary, /player \(玩家账号表\)/);
    assert.match(context.schemaSummary, /id: int/);
    assert.match(context.schemaSummary, /username: varchar\(32\)/);
  });

  it("includes the selected cell in the agent context when available", async () => {
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") return "started";
      return null;
    };
    const workspace = {
      connectionId: "demo",
      database: "game_db",
      selectedCell: { tabId: "tab-player", rowKey: "id=1", column: "username" },
    };
    const activeTab = {
      id: "tab-player",
      connectionId: "demo",
      database: "game_db",
      tableName: "player",
      columns: [{ column_name: "id" }, { column_name: "username" }],
      rows: [{ id: "1", username: "Alice" }],
    };
    const agent = useAgent(workspace, invokeWorkbench);

    agent.draft.value = "这格是什么";
    await agent.send(activeTab);

    const context = invocations[0].payload.context;
    assert.equal(context.selectedColumn, "username");
    assert.equal(context.selectedRowKey, "id=1");
    assert.equal(context.selectedCellValuePreview, "Alice");
    assert.deepEqual(context.visibleColumns, ["id", "username"]);
  });

  it("prewarms a session and sends later messages with the latest active table context", async () => {
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") return "started";
      return null;
    };

    const agent = useAgent({ connectionId: "demo", database: "game_db" }, invokeWorkbench);
    await agent.prewarm({ connectionId: "demo", database: "game_db", tableName: "player" });
    await flushPromises();

    assert.deepEqual(invocations.map((invocation) => invocation.command), ["agent_start_session"]);
    assert.equal(agent.status.value, "idle");
    assert.equal(agent.isStarting.value, false);
    assert.equal(agent.startupProgress.value.visible, false);

    emitMockEvent("agent-event", { ev: "system_init", sessionId: "sess-warm" });
    await flushPromises();
    await nextTick();

    assert.equal(agent.status.value, "idle");

    agent.draft.value = "show me the current table";
    await agent.send({ connectionId: "demo", database: "game_db", tableName: "guild" });

    assert.deepEqual(invocations.map((invocation) => invocation.command), ["agent_start_session", "agent_send"]);
    assert.equal(invocations[1].payload.context.connectionId, "demo");
    assert.equal(invocations[1].payload.context.database, "game_db");
    assert.equal(invocations[1].payload.context.activeTableName, "guild");
  });

  it("queues send behind an in-flight prewarm instead of dropping the message", async () => {
    let resolveStart;
    const invocations = [];
    const invokeWorkbench = async (command, payload) => {
      invocations.push({ command, payload });
      if (command === "agent_start_session") {
        return new Promise((resolve) => {
          resolveStart = () => resolve("started");
        });
      }
      return null;
    };

    const agent = useAgent({ connectionId: "demo", database: "game_db" }, invokeWorkbench);
    const prewarmPromise = agent.prewarm({ connectionId: "demo", database: "game_db", tableName: "player" });
    await flushPromises();

    assert.equal(agent.status.value, "idle");
    assert.equal(agent.isStarting.value, false);
    assert.equal(agent.startupProgress.value.visible, false);

    emitMockEvent("agent-event", {
      ev: "startup_progress",
      stage: "runtime",
      message: "loading native runtime",
      progress: 72,
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.status.value, "idle");
    assert.equal(agent.startupProgress.value.visible, false);
    assert.equal(agent.startupProgress.value.percent, 0);

    agent.draft.value = "describe this table";
    const sendPromise = agent.send({ connectionId: "demo", database: "game_db", tableName: "match_log" });
    await flushPromises();

    assert.equal(agent.messages.value.length, 1);
    assert.equal(agent.messages.value[0].content, "describe this table");
    assert.deepEqual(invocations.map((invocation) => invocation.command), ["agent_start_session"]);

    resolveStart();
    await prewarmPromise;
    await sendPromise;

    assert.deepEqual(invocations.map((invocation) => invocation.command), ["agent_start_session", "agent_send"]);
    assert.equal(invocations[1].payload.context.activeTableName, "match_log");
  });

  it("records tool_use and tool_result events", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "query";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "system_init", sessionId: "sess-3" });
    emitMockEvent("agent-event", { ev: "tool_use", id: "tu-1", name: "run_read_query", input: { sql: "SELECT 1" } });
    emitMockEvent("agent-event", {
      ev: "tool_result",
      id: "tu-1",
      summary: "1 row",
      result: {
        references: [
          { kind: "cell", tableName: "player", columnName: "name", rowIdentity: { id: "1" } },
        ],
      },
      isError: false,
    });
    emitMockEvent("agent-event", { ev: "text_delta", text: "Done" });
    emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "Done" });

    await flushPromises();
    await nextTick();

    const assistant = agent.messages.value[1];
    assert.equal(assistant.toolUses.length, 1);
    assert.equal(assistant.toolUses[0].name, "run_read_query");
    assert.equal(assistant.toolResults.length, 1);
    assert.equal(assistant.toolResults[0].summary, "1 row");
    assert.deepEqual(assistant.toolResults[0].result.references[0], {
      kind: "cell",
      tableName: "player",
      columnName: "name",
      rowIdentity: { id: "1" },
    });
  });

  it("tracks database profile readiness from profile tool calls", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "这个库的核心表是什么";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "system_init", sessionId: "sess-profile" });
    emitMockEvent("agent-event", { ev: "tool_use", id: "profile-1", name: "get_database_profile", input: { database: "game_db" } });
    assert.equal(agent.databaseProfileStatus.value.state, "refreshing");
    assert.equal(agent.databaseProfileStatus.value.label, "数据库理解：刷新中");

    emitMockEvent("agent-event", {
      ev: "tool_result",
      id: "profile-1",
      summary: "profile ready",
      result: { status: "ready", database: "game_db", tableCount: 8 },
      isError: false,
    });

    assert.equal(agent.databaseProfileStatus.value.state, "ready");
    assert.equal(agent.databaseProfileStatus.value.label, "数据库理解：已就绪");

    emitMockEvent("agent-event", { ev: "tool_use", id: "profile-2", name: "refresh_database_profile", input: { database: "game_db" } });
    emitMockEvent("agent-event", {
      ev: "tool_result",
      id: "profile-2",
      summary: "failed",
      result: null,
      isError: true,
    });

    assert.equal(agent.databaseProfileStatus.value.state, "failed");
    assert.equal(agent.databaseProfileStatus.value.label, "数据库理解：失败");
  });

  it("stores mode changes before the sidecar is running without sending backend commands", async () => {
    const invocations = [];
    const agent = useAgent({}, async (command, payload) => {
      invocations.push({ command, payload });
      throw new Error("should not call backend before start");
    });

    await agent.setMode("plan");
    await agent.setAutoApprove(true);

    assert.equal(agent.permissionMode.value, "plan");
    assert.equal(agent.autoApproveWrites.value, true);
    assert.equal(agent.error.value, "");
    assert.deepEqual(invocations, []);
  });

  it("sends mode changes to an already running sidecar", async () => {
    const invocations = [];
    const agent = useAgent({}, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    agent.draft.value = "hello";
    await agent.send();
    await agent.setMode("plan");
    await agent.setAutoApprove(true);

    assert.deepEqual(invocations.map((invocation) => invocation.command), [
      "agent_start_session",
      "agent_send",
      "agent_set_mode",
      "agent_set_auto_approve",
    ]);
    assert.equal(invocations[2].payload.mode, "plan");
    assert.equal(invocations[3].payload.on, true);
  });

  it("records plan requests and returns to idle so the user can approve them", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "plan the change";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", { ev: "plan", req_id: "plan-1", text: "1. inspect\n2. update" });
    await flushPromises();
    await nextTick();

    assert.equal(agent.pendingPlans.value.length, 1);
    assert.equal(agent.pendingPlans.value[0].reqId, "plan-1");
    assert.equal(agent.status.value, "idle");
    assert.equal(agent.isBusy.value, false);
  });

  it("records approval requests and returns to idle so approval buttons are usable", async () => {
    const agent = useAgent({}, async () => null);
    agent.draft.value = "update row";
    agent.send();
    await flushPromises();

    emitMockEvent("agent-event", {
      ev: "approval_request",
      req_id: "approval-1",
      toolName: "mcp__dbscout-db__run_write_query",
      input: { sql: "UPDATE player SET username = 'Admin' WHERE id = 1" },
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.pendingApprovals.value.length, 1);
    assert.equal(agent.pendingApprovals.value[0].reqId, "approval-1");
    assert.equal(agent.status.value, "idle");
    assert.equal(agent.isBusy.value, false);
  });

  it("resumes the selected session id instead of treating it as active tab context", async () => {
    const invocations = [];
    const agent = useAgent({ connectionId: "demo", database: "game_db" }, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    await agent.resumeSession("session-selected");

    // Picking a saved session must not start a query — it just loads transcript.
    assert.equal(agent.lastSessionId.value, "session-selected");
    assert.equal(invocations[0].command, "agent_get_session_messages");
    assert.equal(invocations[0].payload.sessionId, "session-selected");

    // The actual SDK resume happens lazily on the next user message, with the
    // workspace context preserved as the active connection.
    agent.draft.value = "follow up";
    await agent.send();

    const start = invocations.find((invocation) => invocation.command === "agent_start_session");
    assert.ok(start, "agent_start_session should fire on next send");
    assert.equal(start.payload.resumeSessionId, "session-selected");
    assert.equal(start.payload.context.connectionId, "demo");
    assert.equal(start.payload.context.database, "game_db");
  });

  it("loads transcript when resuming a saved session and the next send resumes it", async () => {
    const invocations = [];
    const agent = useAgent({ connectionId: "demo", database: "game_db" }, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    // Send once so a sidecar query is "live", mirroring the user's prior turn.
    agent.draft.value = "hello";
    await agent.send();

    // User clicks a different session in the history list.
    await agent.resumeSession("session-next");

    // Sidecar replies with the transcript for that session.
    emitMockEvent("agent-event", {
      ev: "session_messages",
      sessionId: "session-next",
      messages: [
        { id: "u1", role: "user", content: "previous question" },
        { id: "a1", role: "assistant", content: "previous answer" },
      ],
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.messages.value.length, 2);
    assert.equal(agent.messages.value[0].role, "user");
    assert.equal(agent.messages.value[0].content, "previous question");
    assert.equal(agent.messages.value[1].role, "assistant");
    assert.equal(agent.messages.value[1].done, true);
    assert.equal(agent.lastSessionId.value, "session-next");

    // The next outgoing message must resume the loaded session.
    agent.draft.value = "follow up";
    await agent.send();

    const commands = invocations.map((invocation) => invocation.command);
    assert.deepEqual(commands, [
      "agent_start_session",
      "agent_send",
      "agent_get_session_messages",
      "agent_start_session",
      "agent_send",
    ]);
    assert.equal(invocations[2].payload.sessionId, "session-next");
    assert.equal(invocations[3].payload.resumeSessionId, "session-next");
  });

  it("preserves raw transcript metadata when replaying saved session messages", async () => {
    const agent = useAgent({}, async () => null);

    await agent.resumeSession("session-with-metadata");
    emitMockEvent("agent-event", {
      ev: "session_messages",
      sessionId: "session-with-metadata",
      messages: [
        { id: "u1", role: "user", content: "previous question", contextLabel: "game_db.player" },
        {
          id: "a1",
          role: "assistant",
          content: "previous answer",
          startedAt: 100,
          completedAt: 175,
          elapsedMs: 75,
        },
        { id: "u2", role: "user", content: "older question" },
        { id: "a2", role: "assistant", content: "older answer" },
      ],
    });
    await flushPromises();
    await nextTick();

    assert.equal(agent.messages.value[0].contextLabel, "game_db.player");
    assert.equal(agent.messages.value[1].startedAt, 100);
    assert.equal(agent.messages.value[1].completedAt, 175);
    assert.equal(agent.messages.value[1].elapsedMs, 75);
    assert.equal(agent.messages.value[2].contextLabel, undefined);
    assert.equal(agent.messages.value[3].startedAt, undefined);
    assert.equal(agent.messages.value[3].completedAt, undefined);
    assert.equal(agent.messages.value[3].elapsedMs, undefined);
  });

  it("regenerates an assistant response from the previous user message and original context", async () => {
    const invocations = [];
    const agent = useAgent({ connectionId: "demo", database: "game_db" }, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    agent.draft.value = "describe player";
    await agent.send({ connectionId: "demo", database: "game_db", tableName: "player" });
    emitMockEvent("agent-event", { ev: "text_delta", text: "old answer" });
    emitMockEvent("agent-event", { ev: "result", text: "old answer" });
    await flushPromises();
    await nextTick();

    const assistantId = agent.messages.value[1].id;
    agent.messages.value.push({ id: "u-next", role: "user", content: "later question", contextLabel: "game_db.guild" });
    agent.messages.value.push({ id: "a-next", role: "assistant", content: "later answer", done: true });

    await agent.regenerate(assistantId, { connectionId: "demo", database: "game_db", tableName: "guild" });

    assert.deepEqual(agent.messages.value.map((message) => message.content), ["describe player"]);
    assert.equal(agent.messages.value[0].contextLabel, "game_db.player");

    const sends = invocations.filter((invocation) => invocation.command === "agent_send");
    assert.equal(sends.length, 2);
    assert.equal(sends[1].payload.text, "describe player");
    assert.equal(sends[1].payload.context.database, "game_db");
    assert.equal(sends[1].payload.context.activeTableName, "player");
  });

  it("regenerates database-level replayed messages without borrowing the current table", async () => {
    const invocations = [];
    const agent = useAgent({ connectionId: "demo", database: "game_db" }, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    await agent.resumeSession("session-database-context");
    emitMockEvent("agent-event", {
      ev: "session_messages",
      sessionId: "session-database-context",
      messages: [
        { id: "u1", role: "user", content: "summarize database", contextLabel: "game_db" },
        { id: "a1", role: "assistant", content: "old answer" },
      ],
    });
    await flushPromises();
    await nextTick();

    await agent.regenerate("a1", { connectionId: "demo", database: "game_db", tableName: "player" });

    const send = invocations.find((invocation) => invocation.command === "agent_send");
    assert.equal(send.payload.text, "summarize database");
    assert.equal(send.payload.context.database, "game_db");
    assert.equal(send.payload.context.activeTableName, "");
  });

  it("regenerates replayed messages with the original project context only", async () => {
    const projectContext = {
      currentProjectForAgent: {
        value: {
          id: "project-b",
          name: "Project B",
          rootPath: "E:/projects/project-b",
          shortPath: "E:/projects/project-b",
          readOnly: true,
          available: true,
        },
      },
    };

    async function replayAndRegenerate(sessionId, replayMessages, assistantId) {
      const invocations = [];
      const agent = useAgent(
        { connectionId: "demo", database: "game_db" },
        async (command, payload) => {
          invocations.push({ command, payload });
          return null;
        },
        projectContext,
      );

      await agent.resumeSession(sessionId);
      emitMockEvent("agent-event", {
        ev: "session_messages",
        sessionId,
        messages: replayMessages,
      });
      await flushPromises();
      await nextTick();

      await agent.regenerate(assistantId, { connectionId: "demo", database: "game_db", tableName: "current_table" });
      return invocations.find((invocation) => invocation.command === "agent_send");
    }

    const noProjectSend = await replayAndRegenerate(
      "session-without-project",
      [
        {
          id: "u-no-project",
          role: "user",
          content: "summarize database only",
          contextLabel: "game_db",
          context: {
            connectionId: "demo",
            database: "game_db",
            activeTableName: "",
          },
        },
        { id: "a-no-project", role: "assistant", content: "old database answer" },
      ],
      "a-no-project",
    );
    const legacyNoProjectSend = await replayAndRegenerate(
      "session-without-project-snapshot",
      [
        {
          id: "u-legacy-no-project",
          role: "user",
          content: "summarize legacy database only",
          contextLabel: "game_db",
        },
        { id: "a-legacy-no-project", role: "assistant", content: "old legacy database answer" },
      ],
      "a-legacy-no-project",
    );
    const projectASend = await replayAndRegenerate(
      "session-with-project-a",
      [
        {
          id: "u-project-a",
          role: "user",
          content: "summarize project A",
          contextLabel: "game_db",
          projectLabel: "项目：Project A",
          context: {
            connectionId: "demo",
            database: "game_db",
            activeTableName: "",
            project: {
              id: "project-a",
              name: "Project A",
              rootPath: "E:/projects/project-a",
              shortPath: "E:/projects/project-a",
              readOnly: true,
              available: true,
            },
          },
        },
        { id: "a-project-a", role: "assistant", content: "old project answer" },
      ],
      "a-project-a",
    );

    assert.deepEqual(
      [
        {
          text: noProjectSend.payload.text,
          projectName: noProjectSend.payload.context.project?.name ?? null,
          projectRootPath: noProjectSend.payload.context.project?.rootPath ?? null,
        },
        {
          text: legacyNoProjectSend.payload.text,
          projectName: legacyNoProjectSend.payload.context.project?.name ?? null,
          projectRootPath: legacyNoProjectSend.payload.context.project?.rootPath ?? null,
        },
        {
          text: projectASend.payload.text,
          projectName: projectASend.payload.context.project?.name ?? null,
          projectRootPath: projectASend.payload.context.project?.rootPath ?? null,
        },
      ],
      [
        {
          text: "summarize database only",
          projectName: null,
          projectRootPath: null,
        },
        {
          text: "summarize legacy database only",
          projectName: null,
          projectRootPath: null,
        },
        {
          text: "summarize project A",
          projectName: "Project A",
          projectRootPath: "E:/projects/project-a",
        },
      ],
    );
  });

  it("clears the stored current session when deleting it", async () => {
    const invocations = [];
    const agent = useAgent({}, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    emitMockEvent("agent-event", { ev: "system_init", sessionId: "session-to-delete" });
    await flushPromises();
    await nextTick();

    await agent.deleteSession("session-to-delete");

    assert.equal(agent.lastSessionId.value, null);
    assert.equal(agent.sessionId.value, null);
    assert.equal(invocations[0].command, "agent_delete_session");
  });

  it("includes the current read-only project in start and send context", async () => {
    const invocations = [];
    const projectContext = {
      currentProjectForAgent: {
        value: {
          id: "mock-project",
          name: "dbscout-workbench",
          rootPath: "E:/project/dbscout-workbench",
          shortPath: "E:/project/dbscout-workbench",
          readOnly: true,
          available: true,
        },
      },
    };
    const agent = useAgent(
      { connectionId: "demo", database: "game_db", schema: [] },
      async (command, payload) => {
        invocations.push({ command, payload });
        if (command === "agent_start_session") return "started";
        return null;
      },
      projectContext,
    );

    agent.draft.value = "read project";
    await agent.send({ connectionId: "demo", database: "game_db", tableName: "player" });

    const start = invocations.find((call) => call.command === "agent_start_session");
    const send = invocations.find((call) => call.command === "agent_send");
    assert.equal(start.payload.context.project.name, "dbscout-workbench");
    assert.equal(start.payload.context.project.readOnly, true);
    assert.equal(send.payload.context.project.rootPath, "E:/project/dbscout-workbench");
    assert.equal(agent.messages.value[0].contextLabel, "game_db.player");
    assert.equal(agent.messages.value[0].projectLabel, "项目：dbscout-workbench");
  });

  it("starts a cold regeneration with the replayed project context instead of the current project", async () => {
    const invocations = [];
    const projectContext = {
      currentProjectForAgent: {
        value: {
          id: "project-b",
          name: "Project B",
          rootPath: "E:/projects/project-b",
          shortPath: "E:/projects/project-b",
          readOnly: true,
          available: true,
        },
      },
    };
    const agent = useAgent(
      { connectionId: "demo", database: "game_db" },
      async (command, payload) => {
        invocations.push({ command, payload });
        if (command === "agent_start_session") return "started";
        return null;
      },
      projectContext,
    );

    await agent.resumeSession("session-project-a");
    emitMockEvent("agent-event", {
      ev: "session_messages",
      sessionId: "session-project-a",
      messages: [
        {
          id: "u-project-a",
          role: "user",
          content: "summarize project A",
          contextLabel: "game_db",
          projectLabel: "项目：Project A",
          context: {
            connectionId: "demo",
            database: "game_db",
            activeTableName: "",
            project: {
              id: "project-a",
              name: "Project A",
              rootPath: "E:/projects/project-a",
              shortPath: "E:/projects/project-a",
              readOnly: true,
              available: true,
            },
          },
        },
        { id: "a-project-a", role: "assistant", content: "old project answer" },
      ],
    });
    await flushPromises();
    await nextTick();

    await agent.regenerate("a-project-a", { connectionId: "demo", database: "game_db", tableName: "current_table" });

    const start = invocations.find((invocation) => invocation.command === "agent_start_session");
    const send = invocations.find((invocation) => invocation.command === "agent_send");
    assert.equal(start.payload.context.project.name, "Project A");
    assert.equal(start.payload.context.project.rootPath, "E:/projects/project-a");
    assert.equal(send.payload.context.project.name, "Project A");
    assert.equal(send.payload.context.project.rootPath, "E:/projects/project-a");
  });

  it("starts a cold regeneration without a project when replayed history had none", async () => {
    const invocations = [];
    const projectContext = {
      currentProjectForAgent: {
        value: {
          id: "project-b",
          name: "Project B",
          rootPath: "E:/projects/project-b",
          shortPath: "E:/projects/project-b",
          readOnly: true,
          available: true,
        },
      },
    };
    const agent = useAgent(
      { connectionId: "demo", database: "game_db" },
      async (command, payload) => {
        invocations.push({ command, payload });
        if (command === "agent_start_session") return "started";
        return null;
      },
      projectContext,
    );

    await agent.resumeSession("session-no-project");
    emitMockEvent("agent-event", {
      ev: "session_messages",
      sessionId: "session-no-project",
      messages: [
        {
          id: "u-no-project",
          role: "user",
          content: "summarize database only",
          contextLabel: "game_db",
          context: {
            connectionId: "demo",
            database: "game_db",
            activeTableName: "",
          },
        },
        { id: "a-no-project", role: "assistant", content: "old database answer" },
      ],
    });
    await flushPromises();
    await nextTick();

    await agent.regenerate("a-no-project", { connectionId: "demo", database: "game_db", tableName: "current_table" });

    const start = invocations.find((invocation) => invocation.command === "agent_start_session");
    const send = invocations.find((invocation) => invocation.command === "agent_send");
    assert.equal(start.payload.context.project, undefined);
    assert.equal(send.payload.context.project, undefined);
  });
});

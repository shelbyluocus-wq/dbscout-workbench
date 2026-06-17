import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";
import { useAgent } from "./useAgent.js";
import { emitMockEvent } from "../mock/mockEventBus.js";

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useAgent", () => {
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
    emitMockEvent("agent-event", { ev: "tool_result", id: "tu-1", summary: "1 row", isError: false });
    emitMockEvent("agent-event", { ev: "text_delta", text: "Done" });
    emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "Done" });

    await flushPromises();
    await nextTick();

    const assistant = agent.messages.value[1];
    assert.equal(assistant.toolUses.length, 1);
    assert.equal(assistant.toolUses[0].name, "run_read_query");
    assert.equal(assistant.toolResults.length, 1);
    assert.equal(assistant.toolResults[0].summary, "1 row");
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

    assert.equal(agent.lastSessionId.value, "session-selected");
    assert.equal(invocations[0].command, "agent_start_session");
    assert.equal(invocations[0].payload.resume_session_id, "session-selected");
    assert.equal(invocations[0].payload.context.connectionId, "demo");
    assert.equal(invocations[0].payload.context.database, "game_db");
  });

  it("can switch to another persisted session while a session is already started", async () => {
    const invocations = [];
    const agent = useAgent({ connectionId: "demo", database: "game_db" }, async (command, payload) => {
      invocations.push({ command, payload });
      return null;
    });

    agent.draft.value = "hello";
    await agent.send();
    await agent.resumeSession("session-next");

    assert.deepEqual(invocations.map((invocation) => invocation.command), [
      "agent_start_session",
      "agent_send",
      "agent_start_session",
    ]);
    assert.equal(invocations[2].payload.resume_session_id, "session-next");
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
});

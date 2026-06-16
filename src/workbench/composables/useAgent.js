import { computed, ref, watch } from "vue";
import { listenWorkbenchEvent } from "../utils/tauriBridge.js";

export const DEFAULT_AGENT_API_URL = "";
export const DEFAULT_AGENT_MODEL = "";
export const DEFAULT_AGENT_PERMISSION_MODE = "default";

const AGENT_CONFIG_KEY = "dbscout-agent-config";
const AGENT_SESSION_KEY = "dbscout-agent-session";

function loadAgentConfig() {
  try {
    const raw = localStorage.getItem(AGENT_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAgentConfig(config) {
  try {
    localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

function loadLastSessionId() {
  try {
    return localStorage.getItem(AGENT_SESSION_KEY) || null;
  } catch {
    return null;
  }
}

function saveLastSessionId(id) {
  try {
    if (id) localStorage.setItem(AGENT_SESSION_KEY, id);
    else localStorage.removeItem(AGENT_SESSION_KEY);
  } catch {
    // ignore
  }
}

function activeContext(workspace, activeTab) {
  return {
    connectionId: String(activeTab?.connectionId || workspace?.connectionId || ""),
    database: String(activeTab?.database || workspace?.database || ""),
    activeTableName: String(activeTab?.tableName || ""),
  };
}

function formatSchemaSummary(schema) {
  if (!Array.isArray(schema) || schema.length === 0) return "";
  const lines = [];
  for (const table of schema.slice(0, 80)) {
    const tableName = table.table_name || "";
    const comment = table.table_comment || "";
    lines.push(`- ${tableName}${comment ? ` (${comment})` : ""}`);
    const columns = Array.isArray(table.columns) ? table.columns : [];
    for (const column of columns.slice(0, 30)) {
      const name = column.column_name || "";
      const type = column.column_type || column.data_type || "";
      const colComment = column.column_comment || "";
      const pk = column.is_primary_key ? " PK" : "";
      const nullable = column.is_nullable ? " nullable" : "";
      lines.push(`  - ${name}: ${type}${pk}${nullable}${colComment ? ` // ${colComment}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function useAgent(workspace, invokeWorkbench) {
  const savedConfig = loadAgentConfig();
  const apiKey = ref(savedConfig?.apiKey ?? "");
  const apiUrl = ref(savedConfig?.apiUrl ?? DEFAULT_AGENT_API_URL);
  const model = ref(savedConfig?.model ?? DEFAULT_AGENT_MODEL);
  const permissionMode = ref(savedConfig?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE);
  const autoApproveWrites = ref(savedConfig?.autoApproveWrites ?? false);
  const lastSessionId = ref(loadLastSessionId());

  const draft = ref("");
  const messages = ref([]);
  const status = ref("idle"); // idle | starting | thinking | streaming | error
  const error = ref("");
  const sessionId = ref(null);
  const pendingApprovals = ref([]);
  const sessions = ref([]);

  const isBusy = computed(
    () => status.value === "starting" || status.value === "thinking" || status.value === "streaming"
  );

  let unlisten = null;
  let started = false;

  watch(
    [apiKey, apiUrl, model, permissionMode, autoApproveWrites],
    () => {
      saveAgentConfig({
        apiKey: apiKey.value,
        apiUrl: apiUrl.value,
        model: model.value,
        permissionMode: permissionMode.value,
        autoApproveWrites: autoApproveWrites.value,
      });
    },
    { deep: true }
  );

  async function ensureListener() {
    if (unlisten) return;
    unlisten = await listenWorkbenchEvent("agent-event", (event) => {
      handleEvent(event.payload);
    });
  }

  function appendUserMessage(text) {
    messages.value.push({
      id: `agent-user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      content: text,
    });
  }

  function ensureAssistantMessage() {
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant" && !last.done) {
      return last;
    }
    const message = {
      id: `agent-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "assistant",
      content: "",
      thinking: "",
      done: false,
    };
    messages.value.push(message);
    return message;
  }

  function handleEvent(payload) {
    if (!payload || typeof payload !== "object") return;
    const ev = payload.ev;

    switch (ev) {
      case "system_init": {
        if (payload.sessionId) {
          sessionId.value = payload.sessionId;
          lastSessionId.value = payload.sessionId;
          saveLastSessionId(payload.sessionId);
        }
        if (status.value === "starting") {
          status.value = "thinking";
        }
        break;
      }
      case "error": {
        status.value = "error";
        error.value = String(payload.message || "Agent error");
        break;
      }
      case "text_delta": {
        status.value = "streaming";
        const message = ensureAssistantMessage();
        message.content += String(payload.text || "");
        break;
      }
      case "thinking_delta": {
        status.value = "thinking";
        const message = ensureAssistantMessage();
        message.thinking += String(payload.text || "");
        break;
      }
      case "tool_use": {
        const message = ensureAssistantMessage();
        if (!message.toolUses) message.toolUses = [];
        message.toolUses.push({
          id: payload.id,
          name: payload.name,
          input: payload.input,
        });
        break;
      }
      case "tool_result": {
        const message = ensureAssistantMessage();
        if (!message.toolResults) message.toolResults = [];
        message.toolResults.push({
          id: payload.id,
          summary: payload.summary,
          isError: payload.isError,
        });
        break;
      }
      case "result": {
        const message = ensureAssistantMessage();
        message.done = true;
        if (payload.text && !message.content) {
          message.content = String(payload.text);
        }
        status.value = "idle";
        break;
      }
      case "approval_request": {
        pendingApprovals.value.push({
          reqId: payload.req_id,
          toolName: payload.toolName,
          input: payload.input,
        });
        break;
      }
      case "session_list": {
        sessions.value = Array.isArray(payload.sessions) ? payload.sessions : [];
        break;
      }
      case "session_deleted": {
        sessions.value = sessions.value.filter((session) => session.id !== payload.sessionId && session.sessionId !== payload.sessionId);
        break;
      }
      case "closed": {
        status.value = "idle";
        started = false;
        pendingApprovals.value = [];
        break;
      }
      default:
        break;
    }
  }

  async function startSession(activeTab = null, resume = false) {
    await ensureListener();
    const ctx = activeContext(workspace, activeTab);
    const schemaSummary = formatSchemaSummary(workspace?.schema);

    await invokeWorkbench("agent_start_session", {
      context: {
        connectionId: ctx.connectionId,
        connectionLabel: ctx.connectionId,
        database: ctx.database,
        activeTableName: ctx.activeTableName,
        schemaSummary,
      },
      config: {
        apiKey: apiKey.value.trim() || undefined,
        apiUrl: apiUrl.value.trim() || undefined,
        model: model.value.trim() || undefined,
        permissionMode: permissionMode.value,
        autoApproveWrites: autoApproveWrites.value,
      },
      resume_session_id: resume ? lastSessionId.value : undefined,
    });

    started = true;
  }

  async function send(activeTab = null) {
    const text = draft.value.trim();
    if (!text || isBusy.value) return;

    error.value = "";
    appendUserMessage(text);
    draft.value = "";

    if (!started) {
      status.value = "starting";
      try {
        await startSession(activeTab);
      } catch (err) {
        status.value = "error";
        error.value = String(err?.message || err);
        return;
      }
    }

    try {
      await invokeWorkbench("agent_send", { text });
    } catch (err) {
      status.value = "error";
      error.value = String(err?.message || err);
    }
  }

  async function abort() {
    if (!isBusy.value) return;
    try {
      await invokeWorkbench("agent_abort");
      status.value = "idle";
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  function startNewSession() {
    messages.value = [];
    draft.value = "";
    error.value = "";
    status.value = "idle";
    started = false;
    sessionId.value = null;
    pendingApprovals.value = [];
  }

  function clearMessages() {
    messages.value = [];
    error.value = "";
  }

  async function approveTool(reqId) {
    pendingApprovals.value = pendingApprovals.value.filter((item) => item.reqId !== reqId);
    try {
      await invokeWorkbench("agent_approve_tool", { req_id: reqId });
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function denyTool(reqId, message) {
    pendingApprovals.value = pendingApprovals.value.filter((item) => item.reqId !== reqId);
    try {
      await invokeWorkbench("agent_deny_tool", { req_id: reqId, message });
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  function clearApprovals() {
    pendingApprovals.value = [];
  }

  async function listSessions() {
    try {
      await invokeWorkbench("agent_list_sessions", { limit: 50 });
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function deleteSession(id) {
    try {
      await invokeWorkbench("agent_delete_session", { session_id: id });
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function resumeSession(activeTab = null) {
    if (!lastSessionId.value) return;
    await startSession(activeTab, true);
  }

  return {
    apiKey,
    apiUrl,
    model,
    permissionMode,
    autoApproveWrites,
    draft,
    messages,
    status,
    error,
    sessionId,
    isBusy,
    send,
    abort,
    startNewSession,
    clearMessages,
    pendingApprovals,
    approveTool,
    denyTool,
    clearApprovals,
    sessions,
    listSessions,
    deleteSession,
    resumeSession,
    lastSessionId,
  };
}

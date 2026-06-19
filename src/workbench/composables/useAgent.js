import { computed, ref, watch } from "vue";
import { listenWorkbenchEvent } from "../utils/tauriBridge.js";

export const DEFAULT_AGENT_API_URL = "";
export const DEFAULT_AGENT_MODEL = "";
export const DEFAULT_AGENT_PERMISSION_MODE = "default";

const AGENT_CONFIG_KEY = "dbscout-agent-config";
const AGENT_SESSION_KEY = "dbscout-agent-session";
const STARTUP_INITIAL_PROGRESS = 8;
const STARTUP_MAX_ESTIMATE = 92;

function clampProgress(value, fallback = STARTUP_INITIAL_PROGRESS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

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

function normalizeReplayMessage(raw) {
  // The sidecar pre-shapes messages, but it crosses an IPC boundary so we
  // re-coerce types defensively here.
  const role = raw?.role === "assistant" ? "assistant" : "user";
  const id = String(raw?.id || `replay-${role}-${Math.random().toString(16).slice(2)}`);
  const message = {
    id,
    role,
    content: typeof raw?.content === "string" ? raw.content : "",
  };
  if (role === "assistant") {
    message.done = true;
    if (typeof raw?.thinking === "string" && raw.thinking) message.thinking = raw.thinking;
    if (Array.isArray(raw?.toolUses) && raw.toolUses.length > 0) {
      message.toolUses = raw.toolUses.map((tu) => ({
        id: tu?.id || null,
        name: String(tu?.name || ""),
        input: tu?.input ?? null,
      }));
    }
    if (Array.isArray(raw?.toolResults) && raw.toolResults.length > 0) {
      message.toolResults = raw.toolResults.map((tr) => ({
        id: tr?.id || null,
        summary: typeof tr?.summary === "string" ? tr.summary : "",
        isError: tr?.isError === true,
      }));
    }
  }
  return message;
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
  const pendingPlans = ref([]);
  const sessions = ref([]);
  const startupState = ref({
    percent: 0,
    stage: "",
    detail: "",
    startedAt: 0,
  });
  const startupVisible = ref(false);

  const isStarting = computed(() => startupVisible.value && status.value === "starting");
  const isBusy = computed(
    () => isStarting.value || status.value === "thinking" || status.value === "streaming"
  );
  const startupProgress = computed(() => ({
    visible: isStarting.value,
    percent: startupState.value.percent,
    stage: startupState.value.stage,
    title: "正在启动 Database Agent",
    detail: startupState.value.detail || "正在准备本地 Agent 运行时",
    elapsedMs: startupState.value.startedAt ? Date.now() - startupState.value.startedAt : 0,
  }));

  let unlisten = null;
  let started = false;
  let startPromise = null;
  let startupTimer = null;
  let activeStartupMode = "idle";

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

  function stopStartupProgress(complete = false) {
    if (startupTimer) {
      clearInterval(startupTimer);
      startupTimer = null;
    }
    startupVisible.value = false;
    if (complete) {
      startupState.value = {
        ...startupState.value,
        percent: 100,
        stage: "ready",
        detail: "Agent 已就绪",
      };
    }
  }

  function beginStartupProgress() {
    stopStartupProgress();
    startupVisible.value = true;
    startupState.value = {
      percent: STARTUP_INITIAL_PROGRESS,
      stage: "runtime",
      detail: "正在准备本地 Agent 运行时",
      startedAt: Date.now(),
    };
    startupTimer = setInterval(() => {
      if (!isStarting.value) {
        stopStartupProgress();
        return;
      }
      const elapsed = Date.now() - startupState.value.startedAt;
      const next = Math.min(
        STARTUP_MAX_ESTIMATE,
        STARTUP_INITIAL_PROGRESS + Math.floor(elapsed / 700) * 6,
      );
      if (next > startupState.value.percent) {
        startupState.value = {
          ...startupState.value,
          percent: next,
          detail: next >= 56 ? "正在等待 Agent 初始化完成" : startupState.value.detail,
        };
      }
    }, 700);
  }

  function updateStartupProgress(payload) {
    const percent = clampProgress(payload.progress ?? payload.percent, startupState.value.percent || STARTUP_INITIAL_PROGRESS);
    startupState.value = {
      ...startupState.value,
      percent: Math.max(startupState.value.percent, percent),
      stage: String(payload.stage || startupState.value.stage || "runtime"),
      detail: String(payload.message || payload.detail || startupState.value.detail || "正在准备本地 Agent 运行时"),
      startedAt: startupState.value.startedAt || Date.now(),
    };
  }

  function buildAgentContext(activeTab = null) {
    const ctx = activeContext(workspace, activeTab);
    return {
      connectionId: ctx.connectionId,
      connectionLabel: ctx.connectionId,
      database: ctx.database,
      activeTableName: ctx.activeTableName,
      schemaSummary: formatSchemaSummary(workspace?.schema),
    };
  }

  function handleEvent(payload) {
    if (!payload || typeof payload !== "object") return;
    const ev = payload.ev;

    switch (ev) {
      case "startup_progress": {
        if (startupVisible.value) {
          updateStartupProgress(payload);
        }
        break;
      }
      case "system_init": {
        if (payload.sessionId) {
          sessionId.value = payload.sessionId;
          lastSessionId.value = payload.sessionId;
          saveLastSessionId(payload.sessionId);
        }
        if (startupVisible.value) {
          stopStartupProgress(true);
        }
        activeStartupMode = "idle";
        if (status.value === "starting") {
          status.value = "idle";
        }
        break;
      }
      case "error": {
        const message = String(payload.message || "Agent error");
        stopStartupProgress();
        const backgroundStartupError =
          activeStartupMode === "background" && messages.value.length === 0;
        activeStartupMode = "idle";
        started = false;
        if (backgroundStartupError) {
          error.value = "";
          status.value = "idle";
          break;
        }
        status.value = "error";
        error.value = message;
        break;
      }
      case "text_delta": {
        if (startupVisible.value) {
          stopStartupProgress(true);
        }
        activeStartupMode = "idle";
        status.value = "streaming";
        const message = ensureAssistantMessage();
        message.content += String(payload.text || "");
        break;
      }
      case "thinking_delta": {
        if (startupVisible.value) {
          stopStartupProgress(true);
        }
        activeStartupMode = "idle";
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
        stopStartupProgress(true);
        activeStartupMode = "idle";
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
        status.value = "idle";
        break;
      }
      case "plan": {
        pendingPlans.value.push({
          reqId: payload.req_id,
          text: String(payload.text || ""),
          input: payload.input,
        });
        status.value = "idle";
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
      case "session_messages": {
        // The sidecar finished reading a saved transcript. Replace the panel
        // with the historical messages so the user can read past context.
        // The next outgoing send will resume this session id (see `send`).
        //
        // Failure semantics: if the sidecar reports an error AND returned no
        // messages (e.g. the jsonl file wasn't found, or all entries were
        // filtered out), don't silently wipe the current transcript — keep it
        // and surface the error so the user can tell something went wrong.
        const incoming = Array.isArray(payload.messages) ? payload.messages : [];
        const hasError = Boolean(payload.error);
        if (!(hasError && incoming.length === 0)) {
          messages.value = incoming.map(normalizeReplayMessage);
        }
        if (payload.sessionId) {
          sessionId.value = payload.sessionId;
          lastSessionId.value = payload.sessionId;
          saveLastSessionId(payload.sessionId);
        }
        if (hasError) {
          error.value = String(payload.error);
        } else {
          error.value = "";
        }
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          console.debug(
            "[agent:session_messages]",
            payload.sessionId,
            "messages=", incoming.length,
            "error=", payload.error || ""
          );
        }
        break;
      }
      case "closed": {
        stopStartupProgress();
        activeStartupMode = "idle";
        status.value = "idle";
        started = false;
        pendingApprovals.value = [];
        pendingPlans.value = [];
        break;
      }
      default:
        break;
    }
  }

  async function startSession(activeTab = null, resume = false, options = {}) {
    const forceStart = options.force === true;
    if (started && !forceStart) return;
    if (startPromise) {
      await startPromise;
      return;
    }

    await ensureListener();
    const foreground = options.foreground === true;
    activeStartupMode = foreground ? "foreground" : "background";
    if (foreground) {
      status.value = "starting";
      beginStartupProgress();
    }
    startPromise = invokeWorkbench("agent_start_session", {
      context: buildAgentContext(activeTab),
      config: {
        apiKey: apiKey.value.trim() || undefined,
        apiUrl: apiUrl.value.trim() || undefined,
        model: model.value.trim() || undefined,
        permissionMode: permissionMode.value,
        autoApproveWrites: autoApproveWrites.value,
      },
      resumeSessionId: resume ? lastSessionId.value : undefined,
    })
      .then(() => {
        started = true;
      })
      .catch((err) => {
        if (foreground) {
          stopStartupProgress();
          status.value = "error";
          error.value = String(err?.message || err);
        } else if (activeStartupMode === "background") {
          activeStartupMode = "idle";
        }
        throw err;
      })
      .finally(() => {
        startPromise = null;
      });

    await startPromise;
  }

  async function prewarm(activeTab = null) {
    try {
      await startSession(activeTab, false, { foreground: false });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function send(activeTab = null) {
    const text = draft.value.trim();
    if (!text || isBusy.value) return;

    error.value = "";
    appendUserMessage(text);
    draft.value = "";

    if (!started) {
      if (status.value === "idle") {
        status.value = "thinking";
      }
      // If the user is replying inside a session they just opened from history,
      // resume that SDK session rather than starting a brand-new transcript.
      const shouldResume = Boolean(lastSessionId.value);
      try {
        await startSession(activeTab, shouldResume, { foreground: false });
      } catch (err) {
        stopStartupProgress();
        status.value = "error";
        error.value = String(err?.message || err);
        return;
      }
    }

    try {
      await invokeWorkbench("agent_send", { text, context: buildAgentContext(activeTab) });
      if (status.value === "idle") {
        status.value = "thinking";
      }
    } catch (err) {
      status.value = "error";
      error.value = String(err?.message || err);
    }
  }

  async function abort() {
    if (!isBusy.value) return;
    try {
      await invokeWorkbench("agent_abort");
      stopStartupProgress();
      status.value = "idle";
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  function startNewSession() {
    messages.value = [];
    draft.value = "";
    error.value = "";
    stopStartupProgress();
    startupState.value = {
      percent: 0,
      stage: "",
      detail: "",
      startedAt: 0,
    };
    status.value = "idle";
    started = false;
    startPromise = null;
    activeStartupMode = "idle";
    sessionId.value = null;
    lastSessionId.value = null;
    saveLastSessionId(null);
    pendingApprovals.value = [];
    pendingPlans.value = [];
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

  async function setMode(mode) {
    permissionMode.value = mode;
    if (!started && !startPromise) return;
    try {
      if (startPromise) await startPromise;
      await invokeWorkbench("agent_set_mode", { mode });
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function setAutoApprove(on) {
    autoApproveWrites.value = on;
    if (!started && !startPromise) return;
    try {
      if (startPromise) await startPromise;
      await invokeWorkbench("agent_set_auto_approve", { on });
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function approvePlan(reqId) {
    pendingPlans.value = pendingPlans.value.filter((item) => item.reqId !== reqId);
    try {
      await invokeWorkbench("agent_approve_tool", { req_id: reqId });
      permissionMode.value = "default";
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function denyPlan(reqId, message) {
    pendingPlans.value = pendingPlans.value.filter((item) => item.reqId !== reqId);
    try {
      await invokeWorkbench("agent_deny_tool", { req_id: reqId, message });
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
      await invokeWorkbench("agent_delete_session", { sessionId: id });
      if (id === lastSessionId.value) {
        lastSessionId.value = null;
        sessionId.value = null;
        saveLastSessionId(null);
      }
    } catch (err) {
      error.value = String(err?.message || err);
    }
  }

  async function resumeSession(sessionOrActiveTab = null, activeTab = null) {
    const sessionIdToResume =
      typeof sessionOrActiveTab === "string" ? sessionOrActiveTab : lastSessionId.value;
    if (!sessionIdToResume) return;

    // Switching to a different saved session means the live sidecar query (if
    // any) is stale — drop it so the next user `send` re-starts with the new
    // resume id rather than appending to an unrelated turn.
    started = false;
    startPromise = null;
    pendingApprovals.value = [];
    pendingPlans.value = [];
    error.value = "";
    status.value = "idle";

    lastSessionId.value = sessionIdToResume;
    sessionId.value = sessionIdToResume;
    saveLastSessionId(sessionIdToResume);

    await ensureListener();
    try {
      await invokeWorkbench("agent_get_session_messages", { sessionId: sessionIdToResume });
    } catch (err) {
      error.value = String(err?.message || err);
    }
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
    startupProgress,
    isStarting,
    isBusy,
    prewarm,
    send,
    abort,
    startNewSession,
    clearMessages,
    pendingApprovals,
    approveTool,
    denyTool,
    clearApprovals,
    pendingPlans,
    approvePlan,
    denyPlan,
    setMode,
    setAutoApprove,
    sessions,
    listSessions,
    deleteSession,
    resumeSession,
    lastSessionId,
  };
}

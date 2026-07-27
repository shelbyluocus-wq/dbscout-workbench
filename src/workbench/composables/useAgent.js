import { computed, ref, watch } from "vue";
import { listenWorkbenchEvent } from "../utils/tauriBridge.js";
import { buildRowKey } from "../utils/rowIdentity.js";
import { columnName } from "../utils/normalize.js";

export const DEFAULT_AGENT_API_URL = "";
export const DEFAULT_AGENT_MODEL = "";
export const DEFAULT_AGENT_PERMISSION_MODE = "default";

const AGENT_CONFIG_KEY = "dbscout-agent-config";
const AGENT_SESSION_KEY = "dbscout-agent-session";
const STARTUP_INITIAL_PROGRESS = 8;
const STARTUP_MAX_ESTIMATE = 92;
const PROFILE_TOOL_NAMES = new Set([
  "get_database_profile",
  "refresh_database_profile",
  "search_database_profile",
  "find_related_tables",
  "mcp__dbscout-db__get_database_profile",
  "mcp__dbscout-db__refresh_database_profile",
  "mcp__dbscout-db__search_database_profile",
  "mcp__dbscout-db__find_related_tables",
]);

function readViteEnv(key) {
  try {
    return String(import.meta.env?.[key] || "").trim();
  } catch {
    return "";
  }
}

function defaultAgentEnv() {
  const env = {};
  const mappings = [
    ["VITE_DBSCOUT_AGENT_API_KEY", "ANTHROPIC_API_KEY"],
    ["VITE_DBSCOUT_AGENT_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
    ["VITE_DBSCOUT_AGENT_BASE_URL", "ANTHROPIC_BASE_URL"],
    ["VITE_DBSCOUT_AGENT_MODEL", "ANTHROPIC_MODEL"],
  ];
  for (const [viteKey, envKey] of mappings) {
    const value = readViteEnv(viteKey);
    if (value) env[envKey] = value;
  }
  return env;
}

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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeArtifact(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fileName = String(raw.fileName || "").trim();
  const path = String(raw.path || "").trim();
  const format = String(raw.format || "").trim().toLowerCase();
  if (!fileName || !path || !format) return null;
  const artifact = {
    artifactVersion: Number(raw.artifactVersion || 1),
    fileName,
    path,
    directory: String(raw.directory || ""),
    kind: String(raw.kind || "file"),
    format,
    sizeBytes: Math.max(0, Number(raw.sizeBytes || 0)),
    createdAt: String(raw.createdAt || ""),
  };
  if (Number.isFinite(Number(raw.sheetCount))) artifact.sheetCount = Math.max(0, Number(raw.sheetCount));
  if (Number.isFinite(Number(raw.rowCount))) artifact.rowCount = Math.max(0, Number(raw.rowCount));
  return artifact;
}

function formatContextLabel(context) {
  const database = String(context?.database || "").trim();
  const tableName = String(context?.activeTableName || context?.tableName || "").trim();
  if (database && tableName) return `${database}.${tableName}`;
  if (database) return database;
  return tableName;
}

function projectSnapshot(project) {
  if (!project || typeof project !== "object") return null;
  const rootPath = String(project.rootPath || project.path || "").trim();
  const name = String(project.name || "").trim();
  if (!rootPath || !name) return null;
  return {
    id: String(project.id || rootPath),
    name,
    rootPath,
    shortPath: String(project.shortPath || rootPath),
    readOnly: true,
    available: project.available !== false,
  };
}

function formatProjectLabel(project) {
  const snapshot = projectSnapshot(project);
  return snapshot ? `项目：${snapshot.name}` : "";
}

function backendContextSnapshot(context) {
  if (!context || typeof context !== "object") return null;
  const snapshot = { ...context };
  snapshot.connectionId = String(context.connectionId || "");
  snapshot.connectionLabel = String(context.connectionLabel || snapshot.connectionId || "");
  snapshot.database = String(context.database || "");
  snapshot.activeTableName = String(context.activeTableName || context.tableName || "");
  if (hasOwn(context, "schemaSummary")) snapshot.schemaSummary = String(context.schemaSummary || "");
  const project = projectSnapshot(context.project);
  if (project) snapshot.project = project;
  else delete snapshot.project;
  return snapshot;
}

function contextSnapshot(context) {
  const snapshot = {
    connectionId: String(context?.connectionId || ""),
    database: String(context?.database || ""),
    activeTableName: String(context?.activeTableName || context?.tableName || ""),
    selectedColumn: String(context?.selectedColumn || ""),
    selectedRowKey: String(context?.selectedRowKey || ""),
  };
  const project = projectSnapshot(context?.project);
  if (project) snapshot.project = project;
  return snapshot;
}

function activeTabFromContext(context) {
  return {
    connectionId: String(context?.connectionId || ""),
    database: String(context?.database || ""),
    tableName: String(context?.activeTableName || context?.tableName || ""),
  };
}

function activeTabFromContextLabel(label, fallbackActiveTab = null) {
  const value = String(label || "").trim();
  if (!value) return fallbackActiveTab;
  const dotIndex = value.indexOf(".");
  if (dotIndex > 0) {
    return {
      connectionId: fallbackActiveTab?.connectionId,
      database: value.slice(0, dotIndex),
      tableName: value.slice(dotIndex + 1),
    };
  }
  return {
    connectionId: fallbackActiveTab?.connectionId,
    database: value,
    tableName: "",
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
  if (hasOwn(raw, "contextLabel")) message.contextLabel = raw.contextLabel;
  if (hasOwn(raw, "projectLabel")) message.projectLabel = raw.projectLabel;
  if (raw?.context && typeof raw.context === "object") {
    message.context = contextSnapshot(raw.context);
    if (!message.projectLabel) message.projectLabel = formatProjectLabel(message.context.project);
  }
  if (role === "assistant") {
    message.done = true;
    if (hasOwn(raw, "startedAt")) message.startedAt = raw.startedAt;
    if (hasOwn(raw, "completedAt")) message.completedAt = raw.completedAt;
    if (hasOwn(raw, "elapsedMs")) message.elapsedMs = raw.elapsedMs;
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
        result: hasOwn(tr || {}, "result") ? tr.result : null,
        isError: tr?.isError === true,
      }));
    }
    if (Array.isArray(raw?.artifacts) && raw.artifacts.length > 0) {
      message.artifacts = raw.artifacts.map(normalizeArtifact).filter(Boolean);
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

export function useAgent(workspace, invokeWorkbench, projectContext = null) {
  const savedConfig = loadAgentConfig();
  const bundledEnv = defaultAgentEnv();
  const apiKey = ref(savedConfig?.apiKey ?? "");
  const authToken = ref(savedConfig?.authToken ?? "");
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
  const pendingWorkbenchActions = ref([]);
  const controlWorkbenchRequestIds = new Set();
  const externalMcpStatus = ref({
    enabled: false,
    running: false,
    connectedClients: 0,
    protocolVersion: 1,
    endpointFile: "",
    nodePath: "",
    serverPath: "",
    installCommand: "",
  });
  const externalMcpLoading = ref(false);
  const externalMcpError = ref("");
  const profileToolCalls = new Set();
  const databaseProfileState = ref({
    state: "missing",
    database: "",
    tableCount: 0,
    updatedAt: 0,
    error: "",
  });
  const sessions = ref([]);
  // Bumped each time a saved session's transcript is replayed into the panel.
  // Consumers (AgentPanel) watch this to force-scroll to bottom on load.
  const replayCounter = ref(0);
  // Bumped each time the agent config (apiKey/authToken/apiUrl/model/...) is persisted
  // to localStorage. AgentSettings watches this to flash a "已保存" indicator.
  const configSavedAt = ref(0);
  // The sidecar now ships its own Node + Claude Code runtime and can receive
  // credentials from bundled/environment config, so first-run should not be
  // blocked by an API-key form.
  const onboardingComplete = ref(true);
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
  const databaseProfileStatus = computed(() => {
    const state = databaseProfileState.value.state || "missing";
    const labels = {
      missing: "数据库理解：未生成",
      refreshing: "数据库理解：刷新中",
      ready: "数据库理解：已就绪",
      stale: "数据库理解：已过期",
      failed: "数据库理解：失败",
    };
    return {
      ...databaseProfileState.value,
      state,
      label: labels[state] || labels.missing,
    };
  });

  let unlisten = null;
  let controlUnlisten = null;
  let started = false;
  let startPromise = null;
  let startupTimer = null;
  let activeStartupMode = "idle";

  function persistAgentConfig() {
    saveAgentConfig({
      apiKey: apiKey.value,
      authToken: authToken.value,
      apiUrl: apiUrl.value,
      model: model.value,
      permissionMode: permissionMode.value,
      autoApproveWrites: autoApproveWrites.value,
    });
    configSavedAt.value = Date.now();
  }

  watch(
    [apiKey, authToken, apiUrl, model, permissionMode, autoApproveWrites],
    () => {
      persistAgentConfig();
    },
    { deep: true }
  );

  async function ensureListener() {
    if (unlisten) return;
    unlisten = await listenWorkbenchEvent("agent-event", (event) => {
      handleEvent(event.payload);
    });
  }

  // Local control endpoint (external MCP server) UI actions. Registered
  // eagerly on workbench mount — unlike the agent-event listener it must work
  // even when the built-in assistant has never been started.
  async function ensureControlListener() {
    if (controlUnlisten) return;
    controlUnlisten = await listenWorkbenchEvent("control-workbench-action", (event) => {
      const action = normalizeWorkbenchAction(event?.payload || {});
      if (action) {
        controlWorkbenchRequestIds.add(action.requestId);
        pendingWorkbenchActions.value.push(action);
      }
    });
    try {
      const queued = await invokeWorkbench("control_frontend_ready");
      for (const payload of Array.isArray(queued) ? queued : []) {
        const action = normalizeWorkbenchAction(payload || {});
        if (action) {
          controlWorkbenchRequestIds.add(action.requestId);
          pendingWorkbenchActions.value.push(action);
        }
      }
    } catch {
      // Browser mock and older desktop builds do not expose the optional
      // external control endpoint. The built-in assistant remains available.
    }
  }

  async function disposeControlListener() {
    try {
      await invokeWorkbench("control_frontend_unready");
    } catch {
      // Optional integration; ignore when unavailable.
    }
    controlUnlisten?.();
    controlUnlisten = null;
  }

  async function loadExternalMcpStatus() {
    externalMcpLoading.value = true;
    externalMcpError.value = "";
    try {
      externalMcpStatus.value = await invokeWorkbench("get_external_mcp_status");
      return externalMcpStatus.value;
    } catch (err) {
      externalMcpError.value = String(err?.message || err);
      return null;
    } finally {
      externalMcpLoading.value = false;
    }
  }

  async function setExternalMcpEnabled(enabled) {
    externalMcpLoading.value = true;
    externalMcpError.value = "";
    try {
      externalMcpStatus.value = await invokeWorkbench("set_external_mcp_enabled", {
        enabled: Boolean(enabled),
      });
      return externalMcpStatus.value;
    } catch (err) {
      externalMcpError.value = String(err?.message || err);
      return null;
    } finally {
      externalMcpLoading.value = false;
    }
  }

  async function updateControlContext(context) {
    try {
      await invokeWorkbench("control_update_context", { context });
    } catch {
      // Optional integration; ignore when unavailable.
    }
  }

  async function completeControlWorkbenchAction(action, result = {}) {
    if (!controlWorkbenchRequestIds.has(String(action?.requestId || ""))) return;
    await invokeWorkbench("control_complete_ui_action", {
      requestId: action.requestId,
      ok: result.ok !== false,
      message: String(result.message || ""),
      context: result.context || null,
    });
  }

  function appendUserMessage(text, context) {
    const message = {
      id: `agent-user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      content: text,
    };
    const label = formatContextLabel(context);
    const projectLabel = formatProjectLabel(context?.project);
    if (projectLabel) message.projectLabel = projectLabel;
    if (label) message.contextLabel = label;
    if (context) message.context = contextSnapshot(context);
    messages.value.push(message);
    return message;
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
      startedAt: Date.now(),
    };
    messages.value.push(message);
    return message;
  }

  function activeAssistantMessage() {
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant" && !last.done) return last;
    return null;
  }

  function completeAssistantMessage(message = activeAssistantMessage()) {
    if (!message || message.role !== "assistant") return null;
    const completedAt = typeof message.completedAt === "number" ? message.completedAt : Date.now();
    if (typeof message.startedAt !== "number") {
      message.startedAt = completedAt;
    }
    message.completedAt = completedAt;
    message.elapsedMs = Math.max(0, completedAt - message.startedAt);
    message.done = true;
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
    const context = {
      connectionId: ctx.connectionId,
      connectionLabel: ctx.connectionId,
      database: ctx.database,
      activeTableName: ctx.activeTableName,
      schemaSummary: formatSchemaSummary(workspace?.schema),
    };
    const columns = Array.isArray(activeTab?.columns) ? activeTab.columns.map(columnName).filter(Boolean) : [];
    if (columns.length) context.visibleColumns = columns.slice(0, 80);
    const selected = workspace?.selectedCell;
    if (selected && activeTab?.id && selected.tabId === activeTab.id) {
      context.selectedColumn = String(selected.column || "");
      context.selectedRowKey = String(selected.rowKey || "");
      const row = Array.isArray(activeTab.rows)
        ? activeTab.rows.find((candidate) => rowMatchesSelectedCell(activeTab, candidate, selected.rowKey))
        : null;
      if (row && selected.column) {
        context.selectedCellValuePreview = String(row[selected.column] ?? "").slice(0, 160);
      }
    }
    const project = projectSnapshot(projectContext?.currentProjectForAgent?.value);
    if (project) context.project = project;
    return context;
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
        completeAssistantMessage();
        status.value = "error";
        error.value = message;
        break;
      }
      case "auth_required": {
        const message = String(
          payload.message || "请在助手设置中填写 API Key 和请求地址"
        );
        stopStartupProgress();
        activeStartupMode = "idle";
        started = false;
        startPromise = null;
        completeAssistantMessage();
        status.value = "idle";
        error.value = message;
        onboardingComplete.value = false;
        if (!draft.value.trim()) {
          const lastUserMessage = [...messages.value]
            .reverse()
            .find((item) => item?.role === "user" && String(item.content || "").trim());
          if (lastUserMessage) draft.value = String(lastUserMessage.content);
        }
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
        recordProfileToolUse(payload);
        break;
      }
      case "tool_result": {
        const message = ensureAssistantMessage();
        if (!message.toolResults) message.toolResults = [];
        message.toolResults.push({
          id: payload.id,
          summary: payload.summary,
          result: hasOwn(payload, "result") ? payload.result : null,
          isError: payload.isError,
        });
        recordProfileToolResult(payload);
        break;
      }
      case "artifact_created": {
        const artifact = normalizeArtifact(payload.artifact);
        if (!artifact) break;
        const message = ensureAssistantMessage();
        if (!message.artifacts) message.artifacts = [];
        if (!message.artifacts.some((item) => item.path === artifact.path)) {
          message.artifacts.push(artifact);
        }
        break;
      }
      case "result": {
        stopStartupProgress(true);
        activeStartupMode = "idle";
        const message = ensureAssistantMessage();
        if (payload.text && !message.content) {
          message.content = String(payload.text);
        }
        completeAssistantMessage(message);
        status.value = "idle";
        break;
      }
      case "approval_request": {
        completeAssistantMessage();
        pendingApprovals.value.push({
          reqId: payload.req_id,
          toolName: payload.toolName,
          input: payload.input,
        });
        status.value = "idle";
        break;
      }
      case "plan": {
        completeAssistantMessage();
        pendingPlans.value.push({
          reqId: payload.req_id,
          text: String(payload.text || ""),
          input: payload.input,
        });
        status.value = "idle";
        break;
      }
      case "workbench_action": {
        const action = normalizeWorkbenchAction(payload);
        if (action) pendingWorkbenchActions.value.push(action);
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
          // Wake up AgentPanel to force-scroll to the latest message in the
          // newly loaded transcript (skip on failures that preserved the
          // previous transcript — there's nothing new to scroll to).
          replayCounter.value += 1;
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
        completeAssistantMessage();
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
    const context = options.context || buildAgentContext(activeTab);
    const foreground = options.foreground === true;
    activeStartupMode = foreground ? "foreground" : "background";
    if (foreground) {
      status.value = "starting";
      beginStartupProgress();
    }
    const startContext = backendContextSnapshot(options.context) || buildAgentContext(activeTab);
    startPromise = invokeWorkbench("agent_start_session", {
      context: startContext,
      config: {
        apiKey: apiKey.value.trim() || undefined,
        authToken: authToken.value.trim() || undefined,
        apiUrl: apiUrl.value.trim() || undefined,
        model: model.value.trim() || undefined,
        env: Object.keys(bundledEnv).length ? bundledEnv : undefined,
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

  async function sendText(text, context, options = {}) {
    if (!text || isBusy.value) return;

    error.value = "";
    if (options.appendUser !== false) {
      appendUserMessage(text, context);
    }
    if (options.clearDraft === true) {
      draft.value = "";
    }

    if (!started) {
      if (status.value === "idle") {
        status.value = "thinking";
      }
      // If the user is replying inside a session they just opened from history,
      // resume that SDK session rather than starting a brand-new transcript.
      const shouldResume = Boolean(lastSessionId.value);
      try {
        await startSession(activeTabFromContext(context), shouldResume, { foreground: false, context });
      } catch (err) {
        stopStartupProgress();
        status.value = "error";
        error.value = String(err?.message || err);
        return;
      }
    }

    try {
      await invokeWorkbench("agent_send", { text, context });
      if (status.value === "idle") {
        status.value = "thinking";
      }
    } catch (err) {
      status.value = "error";
      error.value = String(err?.message || err);
    }
  }

  async function send(activeTab = null) {
    const text = draft.value.trim();
    const context = buildAgentContext(activeTab);
    await sendText(text, context, { clearDraft: true });
  }

  function buildContextFromUserMessage(message, fallbackActiveTab = null) {
    if (message?.context) {
      const context = buildAgentContext(activeTabFromContext(message.context));
      if (hasOwn(message.context, "project")) {
        const project = projectSnapshot(message.context.project);
        if (project) context.project = project;
        else delete context.project;
      } else {
        delete context.project;
      }
      return context;
    }
    const context = buildAgentContext(activeTabFromContextLabel(message?.contextLabel, fallbackActiveTab));
    delete context.project;
    return context;
  }

  async function regenerate(messageId, activeTab = null) {
    const assistantIndex = messages.value.findIndex(
      (message) => message.id === messageId && message.role === "assistant",
    );
    if (assistantIndex < 0 || isBusy.value) return false;

    let userIndex = -1;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (messages.value[index]?.role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) return false;

    const userMessage = messages.value[userIndex];
    const text = String(userMessage.content || "").trim();
    if (!text) return false;

    const context = buildContextFromUserMessage(userMessage, activeTab);
    messages.value = messages.value.slice(0, assistantIndex);
    await sendText(text, context, { appendUser: false });
    return true;
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

  async function openArtifact(path) {
    if (!String(path || "").trim()) return false;
    try {
      await invokeWorkbench("agent_open_artifact", { path });
      return true;
    } catch (err) {
      error.value = `打开文件失败：${String(err?.message || err)}`;
      return false;
    }
  }

  async function revealArtifact(path) {
    if (!String(path || "").trim()) return false;
    try {
      await invokeWorkbench("agent_reveal_artifact", { path });
      return true;
    } catch (err) {
      error.value = `打开文件所在位置失败：${String(err?.message || err)}`;
      return false;
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

  function markWorkbenchActionHandled(requestId) {
    const id = String(requestId || "");
    controlWorkbenchRequestIds.delete(id);
    pendingWorkbenchActions.value = pendingWorkbenchActions.value.filter((item) => item.requestId !== id);
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

    // No-op if the user clicks the session they're already viewing — the
    // transcript is already on screen, replaying would visibly clear+re-fill.
    // The settings popover still closes (the caller emits "close" regardless).
    if (sessionIdToResume === lastSessionId.value && messages.value.length > 0) {
      return;
    }

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

  /**
   * Clear user overrides so the sidecar uses bundled/environment auth.
   *
   * The watcher above auto-persists the cleared values; we additionally flip
   * the onboarding flag in case every field was already empty and the watcher
   * would not have fired.
   */
  function completeOnboarding() {
    onboardingComplete.value = true;
    persistAgentConfig();
  }

  function useLocalClaudeCodeConfig() {
    apiKey.value = "";
    authToken.value = "";
    apiUrl.value = "";
    model.value = "";
    if (!onboardingComplete.value) {
      onboardingComplete.value = true;
      persistAgentConfig();
    }
  }

  function normalizeWorkbenchAction(payload) {
    const action = String(payload.action || "").trim();
    const supported = new Set(["open_table", "focus_column", "focus_row", "focus_cell", "refresh_table"]);
    if (!supported.has(action)) return null;
    const tableName = String(payload.tableName || payload.table || "").trim();
    if (!tableName) return null;
    const normalized = {
      requestId: String(payload.requestId || `workbench-action-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      action,
      connectionId: String(payload.connectionId || payload.connection_id || ""),
      database: String(payload.database || ""),
      tableName,
      tableComment: String(payload.tableComment || payload.table_comment || ""),
    };
    if (action === "focus_column" || action === "focus_cell") {
      normalized.columnName = String(payload.columnName || payload.column || "").trim();
      if (!normalized.columnName) return null;
    }
    if (action === "focus_row" || action === "focus_cell") {
      normalized.rowKey = String(payload.rowKey || payload.row_key || "").trim();
      normalized.rowIdentity = normalizeRowIdentity(payload.rowIdentity || payload.row_identity);
      if (!normalized.rowKey && !normalized.rowIdentity) return null;
    }
    return normalized;
  }

  function recordProfileToolUse(payload) {
    if (!isProfileToolName(payload?.name)) return;
    if (payload.id) profileToolCalls.add(payload.id);
    databaseProfileState.value = {
      ...databaseProfileState.value,
      state: "refreshing",
      database: String(payload?.input?.database || databaseProfileState.value.database || ""),
      error: "",
    };
  }

  function recordProfileToolResult(payload) {
    const isTracked = payload?.id && profileToolCalls.has(payload.id);
    if (!isTracked && !isProfileResult(payload?.result)) return;
    if (payload?.id) profileToolCalls.delete(payload.id);
    if (payload?.isError) {
      databaseProfileState.value = {
        ...databaseProfileState.value,
        state: "failed",
        error: String(payload.summary || "画像刷新失败"),
        updatedAt: Date.now(),
      };
      return;
    }
    const result = normalizeProfileResult(payload?.result);
    databaseProfileState.value = {
      state: result.status,
      database: result.database,
      tableCount: result.tableCount,
      updatedAt: Date.now(),
      error: "",
    };
  }

  function isProfileToolName(name) {
    return PROFILE_TOOL_NAMES.has(String(name || ""));
  }

  function isProfileResult(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    return hasOwn(result, "status") && (hasOwn(result, "tableCount") || hasOwn(result, "schemaSignature") || hasOwn(result, "table"));
  }

  function normalizeProfileResult(result) {
    const rawStatus = String(result?.status || "ready");
    const status = rawStatus === "stale" ? "stale" : "ready";
    return {
      status,
      database: String(result?.database || databaseProfileState.value.database || ""),
      tableCount: Number.isFinite(Number(result?.tableCount)) ? Number(result.tableCount) : 0,
    };
  }

  function normalizeRowIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      const name = String(key || "").trim();
      if (!name) continue;
      out[name] = String(raw ?? "");
    }
    return Object.keys(out).length ? out : null;
  }

  function rowMatchesSelectedCell(tab, row, rowKey) {
    const key = String(rowKey || "");
    if (!key) return false;
    if (buildRowKey(tab, row) === key) return true;
    const identity = parseRowKey(key);
    const entries = Object.entries(identity);
    return entries.length > 0 && entries.every(([name, value]) => String(row?.[name] ?? "") === value);
  }

  function parseRowKey(rowKey) {
    const out = {};
    for (const part of String(rowKey || "").split("&")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      const key = part.slice(0, index);
      out[key] = part.slice(index + 1);
    }
    return out;
  }

  return {
    apiKey,
    authToken,
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
    databaseProfileStatus,
    isStarting,
    isBusy,
    prewarm,
    send,
    regenerate,
    abort,
    startNewSession,
    clearMessages,
    pendingApprovals,
    approveTool,
    denyTool,
    openArtifact,
    revealArtifact,
    clearApprovals,
    pendingPlans,
    approvePlan,
    denyPlan,
    pendingWorkbenchActions,
    markWorkbenchActionHandled,
    ensureControlListener,
    disposeControlListener,
    completeControlWorkbenchAction,
    updateControlContext,
    externalMcpStatus,
    externalMcpLoading,
    externalMcpError,
    loadExternalMcpStatus,
    setExternalMcpEnabled,
    setMode,
    setAutoApprove,
    sessions,
    listSessions,
    deleteSession,
    resumeSession,
    lastSessionId,
    replayCounter,
    configSavedAt,
    onboardingComplete,
    completeOnboarding,
    useLocalClaudeCodeConfig,
  };
}

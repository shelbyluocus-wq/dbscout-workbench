#!/usr/bin/env node
import {
  query,
  createSdkMcpServer,
  tool,
  listSessions,
  deleteSession,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { mkdirSync } from "node:fs";
import { resolveNativeCliPath } from "./resolveNativeCli.mjs";
import { normalizeAgentProxyEnv } from "./proxyEnv.mjs";
import { createSdkMessageForwarder } from "./sdkMessageForwarder.mjs";
import {
  createPermissionResult,
  isAutoApprovedReadOnlyDbTool,
} from "./toolApproval.mjs";

/**
 * DB Scout Agent Sidecar
 *
 * Bridges the Claude Agent SDK to DB Scout Workbench via JSON-lines stdio.
 * - Reads JSON-lines ops from stdin.
 * - Drives the Claude Agent SDK in streaming-input mode.
 * - DB tools are exposed as an in-process MCP server; each tool call is
 *   forwarded to the host as a db_request event and fulfilled by a db_response op.
 * - Emits JSON-lines events to stdout.
 */

/**
 * Stable working directory pinned to the user's home so the SDK's
 * `persistSession` writes and `listSessions` reads always agree on the
 * same `projectKey`. Tauri spawns the sidecar with a `process.cwd()` that
 * varies between dev (target/debug/...) and production install paths,
 * which would otherwise scatter sessions across many `~/.claude/projects/<key>/`
 * directories and leave the workbench unable to find its own history.
 */
const AGENT_CWD = pathJoin(homedir(), ".dbscout-workbench");
try {
  mkdirSync(AGENT_CWD, { recursive: true });
} catch (err) {
  process.stderr.write(`[sidecar] failed to ensure AGENT_CWD ${AGENT_CWD}: ${err?.message || err}\n`);
}
process.stderr.write(
  `[sidecar] startup processCwd=${process.cwd()} agentCwd=${AGENT_CWD}\n`
);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

/** @type {Query | null} */
let currentQuery = null;

/** @type {InputStream | null} */
let currentInput = null;

/** @type {AbortController | null} */
let currentAbort = null;

let shuttingDown = false;

let currentPermissionMode = "default";
let currentAutoApproveWrites = false;
let currentContext = {};

let nextDbReqId = 1;
let nextApprovalReqId = 1;

let opQueue = Promise.resolve();

/** @type {Map<string, {resolve: (value: any) => void, reject: (reason: Error) => void}>} */
const pendingDbRequests = new Map();

/** @type {Map<string, {input: Record<string, any>, resolve: (value: any) => void, reject: (reason: Error) => void}>} */
const pendingApprovals = new Map();

class InputStream {
  constructor() {
    /** @type {Array<() => void>} */
    this.resolvers = [];
    /** @type {any[]} */
    this.queue = [];
    this.ended = false;
    this.error = null;
  }

  push(message) {
    if (this.ended) return;
    this.queue.push(message);
    const resolve = this.resolvers.shift();
    if (resolve) resolve();
  }

  end() {
    this.ended = true;
    while (this.resolvers.length) this.resolvers.shift()();
  }

  fail(err) {
    this.error = err;
    this.ended = true;
    while (this.resolvers.length) this.resolvers.shift()();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift();
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      await new Promise((resolve) => this.resolvers.push(resolve));
    }
  }
}

function emit(event) {
  console.log(JSON.stringify(event));
}

function emitError(message, details) {
  emit({ ev: "error", message, details });
}

function emitStartupProgress(stage, progress, message) {
  emit({ ev: "startup_progress", stage, progress, message });
}

function emitToolUse(name, input) {
  emit({ ev: "tool_use", name, input });
}

function emitToolResult(name, input, result, isError) {
  emit({
    ev: "tool_result",
    name,
    input,
    result: result ?? null,
    isError: isError ?? false,
  });
}

function formatTurnContext(context) {
  if (!context || typeof context !== "object") return "";
  const lines = [];
  if (context.connectionLabel || context.connectionId) {
    lines.push(`当前连接: ${context.connectionLabel || context.connectionId}`);
  }
  if (context.database) {
    lines.push(`当前数据库: ${context.database}`);
  }
  if (context.activeTableName) {
    lines.push(`当前活动表: ${context.activeTableName}`);
  }
  if (!lines.length) return "";
  return `DB Scout 当前上下文:\n${lines.join("\n")}`;
}

const forwardSdkMessage = createSdkMessageForwarder({
  emit,
  emitError,
  emitToolUse,
  emitToolResult,
});

/**
 * @param {string} func
 * @param {Record<string, any>} args
 * @returns {Promise<any>}
 */
async function requestDb(func, args) {
  const reqId = String(nextDbReqId++);
  emit({ ev: "db_request", req_id: reqId, func, args });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingDbRequests.delete(reqId);
      reject(new Error(`db_request ${func} timed out`));
    }, 60000);

    pendingDbRequests.set(reqId, {
      resolve: (value) => {
        clearTimeout(timeout);
        pendingDbRequests.delete(reqId);
        resolve(value);
      },
      reject: (reason) => {
        clearTimeout(timeout);
        pendingDbRequests.delete(reqId);
        reject(reason);
      },
    });
  });
}

function setPermissionMode(mode) {
  currentPermissionMode = mode;
  if (currentQuery?.setPermissionMode) {
    try {
      currentQuery.setPermissionMode(mode);
    } catch {
      // ignore
    }
  }
}

function extractPlanText(input) {
  if (!input || typeof input !== "object") return "";
  const value =
    input.plan ??
    input.text ??
    input.reasoning ??
    input.summary ??
    input.message ??
    "";
  return String(value);
}

function isWriteTool(toolName) {
  const normalized = normalizeToolName(toolName);
  if (normalized === "run_write_query") return true;
  const writePrefixes = ["Write", "Edit", "Bash", "WebSearch"];
  return writePrefixes.some((prefix) => toolName === prefix || toolName.endsWith(`__${prefix}`));
}

/**
 * @param {string} toolName
 * @param {Record<string, any>} input
 * @param {string} permissionMode
 * @returns {Promise<{behavior: 'allow' | 'deny', message?: string}>}
 */
async function requestApproval(toolName, input, permissionMode) {
  // In plan mode, only ExitPlanMode is allowed to present the plan.
  // Everything else is held until the user approves the plan.
  if (permissionMode === "plan") {
    if (toolName === "ExitPlanMode" || toolName.endsWith("__ExitPlanMode")) {
      const reqId = String(nextApprovalReqId++);
      emit({ ev: "plan", req_id: reqId, toolName, input, text: extractPlanText(input) });

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingApprovals.delete(reqId);
          resolve(createPermissionResult("deny", input, { message: "计划审批超时" }));
        }, 300000);

        pendingApprovals.set(reqId, {
          input,
          resolve: (value) => {
            clearTimeout(timeout);
            pendingApprovals.delete(reqId);
            if (value?.behavior === "allow") {
              setPermissionMode("default");
            }
            resolve(value);
          },
          reject: (reason) => {
            clearTimeout(timeout);
            pendingApprovals.delete(reqId);
            reject(reason);
          },
        });
      });
    }

    return createPermissionResult("deny", input, {
      message: "计划模式仅允许调研工具，请在批准计划后再执行写入/修改操作",
    });
  }

  // Read-only DB tools are safe to auto-approve.
  if (isAutoApprovedReadOnlyDbTool(toolName)) {
    return createPermissionResult("allow", input);
  }

  // Auto-approve write tools when the user has enabled the switch.
  if (currentAutoApproveWrites && isWriteTool(toolName)) {
    return createPermissionResult("allow", input);
  }

  const reqId = String(nextApprovalReqId++);
  emit({ ev: "approval_request", req_id: reqId, toolName, input });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(reqId);
      resolve(createPermissionResult("deny", input, { message: "approval timed out" }));
    }, 300000);

    pendingApprovals.set(reqId, {
      input,
      resolve: (value) => {
        clearTimeout(timeout);
        pendingApprovals.delete(reqId);
        resolve(value);
      },
      reject: (reason) => {
        clearTimeout(timeout);
        pendingApprovals.delete(reqId);
        reject(reason);
      },
    });
  });
}

function createDbTools() {
  const schemas = {
    limit: z.number().int().min(1).max(1000).optional().default(100),
  };

  return [
    tool(
      "list_databases",
      "List all databases/collections accessible from the current connection.",
      {},
      async () => {
        const result = await requestDb("list_databases", {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "list_tables",
      "List tables and views in the selected database.",
      {
        database: z.string().optional(),
        limit: schemas.limit,
      },
      async (args) => {
        const result = await requestDb("list_tables", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "describe_table",
      "Return column names, types, primary keys, and foreign keys for a table.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
      },
      async (args) => {
        const result = await requestDb("describe_table", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "sample_rows",
      "Return a small sample of rows from a table.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional().default(12),
      },
      async (args) => {
        const result = await requestDb("sample_rows", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "search_schema",
      "Search tables and columns whose names or comments match a keyword.",
      {
        keyword: z.string().min(1),
        database: z.string().optional(),
      },
      async (args) => {
        const result = await requestDb("search_schema", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "search_values",
      "Search across table values for a keyword. Use only when the answer is likely in the data itself.",
      {
        keyword: z.string().min(1),
        database: z.string().optional(),
        table: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(20),
      },
      async (args) => {
        const result = await requestDb("search_values", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "run_read_query",
      "Run a read-only SQL SELECT query. The query is validated to be read-only and limited to 1000 rows.",
      {
        sql: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional().default(1000),
      },
      async (args) => {
        const result = await requestDb("run_read_query", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "run_write_query",
      "Run a write SQL query (INSERT/UPDATE/DELETE/REPLACE) inside a transaction. Requires user approval. Returns affected rows.",
      {
        sql: z.string().min(1),
      },
      async (args) => {
        const result = await requestDb("run_write_query", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
  ];
}

function createDbMcpServer() {
  return createSdkMcpServer({
    name: "dbscout-db",
    instructions:
      "You are connected to the current DB Scout Workbench database. " +
      "Use these tools to inspect schema, sample data, and run read-only queries. " +
      "Always prefer listing tables and describing schema before writing SQL.",
    tools: createDbTools(),
    alwaysLoad: true,
  });
}

/**
 * @param {any} msg
 */
function handleSdkMessage(msg) {
  forwardSdkMessage(msg);
}

async function closeCurrentQuery() {
  if (currentQuery) {
    try {
      await currentQuery.close?.();
    } catch {
      // ignore
    }
    currentQuery = null;
  }
  if (currentInput) {
    currentInput.end();
    currentInput = null;
  }
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
}

/**
 * @param {object} op
 */
async function handleStart(op) {
  emitStartupProgress("runtime", 12, "正在准备 Agent 运行时");
  await closeCurrentQuery();

  emitStartupProgress("native_cli", 28, "正在定位 Claude Code 本地运行文件");
  const nativeCliPath = resolveNativeCliPath();
  if (!nativeCliPath) {
    emitError(
      "Failed to locate native Claude Code CLI binary. " +
        "Reinstall the agent sidecar dependencies or verify the bundled binary is present.",
      { platform: process.platform, arch: process.arch }
    );
    return;
  }

  emitStartupProgress("context", 44, "正在装载当前数据库上下文");
  currentAbort = new AbortController();
  currentInput = new InputStream();

  // Merge provided env with inherited process.env so PATH, HOME, ANTHROPIC_API_KEY, etc. are available.
  const providedEnv = op.env && typeof op.env === "object" ? op.env : {};
  const env = await normalizeAgentProxyEnv({ ...process.env, ...providedEnv });
  const context = op.context && typeof op.context === "object" ? op.context : {};
  currentContext = context;
  const permissionMode = op.permissionMode || "default";
  currentPermissionMode = permissionMode;
  currentAutoApproveWrites = op.autoApproveWrites === true;

  const appendParts = [];
  if (context.connectionLabel) {
    appendParts.push(`当前连接: ${context.connectionLabel}`);
  }
  if (context.database) {
    appendParts.push(`当前数据库: ${context.database}`);
  }
  if (context.activeTableName) {
    appendParts.push(`当前活动表: ${context.activeTableName}`);
  }
  if (context.schemaSummary) {
    appendParts.push(`当前数据库结构摘要:\n${context.schemaSummary}`);
  }
  appendParts.push(
    "你是 DB Scout Workbench 的内置数据库助手。你可以使用 dbscout-db 工具来查看当前连接的数据库结构、采样数据和执行只读查询。"
  );
  const append = appendParts.join("\n\n");

  const options = {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append,
    },
    tools: [],
    mcpServers: {
      "dbscout-db": createDbMcpServer(),
    },
    permissionMode,
    canUseTool: async (toolName, input) => {
      return requestApproval(toolName, input, currentPermissionMode);
    },
    includePartialMessages: true,
    env,
    abortController: currentAbort,
    persistSession: true,
    cwd: AGENT_CWD,
    pathToClaudeCodeExecutable: nativeCliPath,
  };

  if (op.resumeSessionId) {
    options.resume = op.resumeSessionId;
  }
  if (op.model) {
    options.model = op.model;
  }

  try {
    emitStartupProgress("sdk", 72, "正在启动 Claude Code 会话");
    currentQuery = query({ prompt: currentInput, options });

    // Start consuming events in the background; do not await here.
    consumeQuery(currentQuery);
    emitStartupProgress("ready_wait", 88, "正在等待 Agent 返回就绪信号");
  } catch (err) {
    const inner = err?.message || String(err);
    emitError(`Failed to start query: ${inner}`, { message: inner, stack: err?.stack });
    await closeCurrentQuery();
  }
}

/**
 * @param {Query} q
 */
async function consumeQuery(q) {
  try {
    for await (const msg of q) {
      handleSdkMessage(msg);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      const inner = err?.message || String(err);
      emitError(`Query consumer error: ${inner}`, { message: inner, stack: err?.stack });
    }
  } finally {
    if (!shuttingDown) {
      emit({ ev: "closed" });
    }
  }
}

/**
 * @param {object} op
 */
async function handleUserMessage(op) {
  if (!currentInput) {
    emitError("No active session");
    return;
  }
  const text = typeof op.text === "string" ? op.text : "";
  if (op.context && typeof op.context === "object") {
    currentContext = op.context;
  }
  const turnContext = formatTurnContext(currentContext);
  const content = turnContext ? `${turnContext}\n\n用户问题:\n${text}` : text;
  currentInput.push({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  });
}

/**
 * @param {object} op
 */
async function handleDbResponse(op) {
  const reqId = op.req_id;
  const pending = pendingDbRequests.get(reqId);
  if (!pending) {
    emitError("Received db_response for unknown request", { req_id: reqId });
    return;
  }

  if (op.ok) {
    pending.resolve(op.data ?? null);
  } else {
    pending.reject(new Error(op.error || "db_request failed"));
  }
}

/**
 * @param {object} op
 */
async function handleApprovalResponse(op) {
  const reqId = op.req_id;
  const pending = pendingApprovals.get(reqId);
  if (!pending) {
    emitError("Received approval_response for unknown request", { req_id: reqId });
    return;
  }

  if (op.allowed) {
    pending.resolve(createPermissionResult("allow", pending.input));
  } else {
    pending.resolve(
      createPermissionResult("deny", pending.input, {
        message: op.message || "denied by user",
      })
    );
  }
}

/**
 * @param {object} op
 */
async function handleSetMode(op) {
  const mode = typeof op.mode === "string" ? op.mode : "default";
  setPermissionMode(mode);
}

/**
 * @param {object} op
 */
async function handleSetAutoApprove(op) {
  currentAutoApproveWrites = op.on === true;
}

/**
 * @param {object} _op
 */
async function handleInterrupt(_op) {
  if (currentQuery?.interrupt) {
    try {
      await currentQuery.interrupt();
    } catch (err) {
      emitError("Interrupt failed", { message: err.message });
    }
  }
}

/**
 * Polish a raw first-prompt / SDK summary into a short display title.
 * - Strips leading markdown noise (>, #, -, *, •, code fences, inline backticks).
 * - Collapses whitespace into single spaces.
 * - Truncates to ~40 user-perceived characters using codepoint-correct slicing
 *   so emoji and CJK extension characters aren't cut mid-surrogate-pair.
 *
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function polishTitle(raw) {
  if (raw == null) return "";
  let s = String(raw).replace(/\r\n?/g, "\n");
  s = s.replace(/^\s*(?:>|#{1,6}|[-*•])\s+/, "");
  s = s.replace(/^\s*```[^\n]*\n?/, "");
  s = s.replace(/^\s*`+\s*/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  const MAX = 40;
  const cps = Array.from(s);
  if (cps.length <= MAX) return s;
  return cps.slice(0, MAX - 1).join("").trimEnd() + "…";
}

/**
 * Map SDK `SDKSessionInfo` records to the shape the workbench expects.
 * The frontend reads `session.title` / `session.updatedAt`; the SDK exposes
 * `customTitle` / `summary` / `firstPrompt` / `lastModified` / `sessionId`.
 * Both `id` and `sessionId` are emitted so `useAgent.js`' `session_deleted`
 * filter (which checks both fields) keeps working.
 *
 * @param {object} op
 */
async function handleListSessions(op) {
  try {
    const raw = await listSessions({ limit: op.limit || 50, dir: AGENT_CWD });
    const rawArr = Array.isArray(raw) ? raw : [];
    process.stderr.write(
      `[list_sessions] dir=${AGENT_CWD} count=${rawArr.length} firstIds=${rawArr
        .slice(0, 3)
        .map((s) => s?.sessionId || "?")
        .join(",")}\n`
    );
    const sessions = rawArr.map((s) => {
      const rawTitle = s?.customTitle || s?.summary || s?.firstPrompt || "";
      return {
        id: s?.sessionId,
        sessionId: s?.sessionId,
        title: polishTitle(rawTitle),
        firstPrompt: s?.firstPrompt || "",
        updatedAt: s?.lastModified,
        createdAt: s?.createdAt || s?.lastModified,
      };
    });
    emit({ ev: "session_list", sessions });
  } catch (err) {
    emitError("Failed to list sessions", { message: err.message });
  }
}

async function handleDeleteSession(op) {
  try {
    await deleteSession(op.sessionId, { dir: AGENT_CWD });
    emit({ ev: "session_deleted", sessionId: op.sessionId });
  } catch (err) {
    emitError("Failed to delete session", { message: err.message });
  }
}

/**
 * Replay a saved session's transcript so the host can render past messages
 * without starting a new turn. Frontend sees a `session_messages` event with a
 * pre-assembled array shaped for the conversation panel.
 *
 * @param {object} op
 */
async function handleGetSessionMessages(op) {
  const sessionId = typeof op.sessionId === "string" ? op.sessionId : "";
  if (!sessionId) {
    emit({ ev: "session_messages", sessionId: "", messages: [], error: "缺少 sessionId" });
    return;
  }
  try {
    const transcript = await getSessionMessages(sessionId, { limit: 1000, dir: AGENT_CWD });
    const messages = buildReplayMessages(transcript);
    const transcriptLen = Array.isArray(transcript) ? transcript.length : -1;
    process.stderr.write(
      `[get_session_messages] dir=${AGENT_CWD} sessionId=${sessionId} transcriptLen=${transcriptLen} messagesLen=${messages.length}\n`
    );
    let error = "";
    if (!Array.isArray(transcript) || transcript.length === 0) {
      error = "未找到该会话的消息文件（可能在其它项目目录）";
    } else if (messages.length === 0) {
      error = `读取到 ${transcript.length} 条原始记录但未能还原任何用户/助手消息（可能仅含系统消息或工具结果）`;
    }
    emit({ ev: "session_messages", sessionId, messages, ...(error ? { error } : {}) });
  } catch (err) {
    process.stderr.write(`[get_session_messages] error: ${err?.stack || err?.message || err}\n`);
    emit({
      ev: "session_messages",
      sessionId,
      messages: [],
      error: err?.message || String(err),
    });
  }
}

/**
 * @param {Array<{ type: 'user' | 'assistant' | 'system', uuid: string, message: any }>} transcript
 */
function buildReplayMessages(transcript) {
  if (!Array.isArray(transcript)) return [];
  const result = [];
  let assistantCounter = 0;

  for (const entry of transcript) {
    if (!entry || typeof entry !== "object") continue;
    const sdkMessage = entry.message;
    if (!sdkMessage || typeof sdkMessage !== "object") continue;

    if (entry.type === "user") {
      const content = sdkMessage.content;
      if (typeof content === "string") {
        const text = stripTurnContextPrefix(content);
        if (text) result.push({ id: `replay-user-${entry.uuid}`, role: "user", content: text });
      } else if (Array.isArray(content)) {
        const textParts = [];
        const toolResults = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            toolResults.push({
              id: block.tool_use_id || null,
              summary: summarizeToolResult(block.content),
              isError: block.is_error === true,
            });
          }
        }
        if (textParts.length > 0) {
          const text = stripTurnContextPrefix(textParts.join("\n\n"));
          if (text) result.push({ id: `replay-user-${entry.uuid}`, role: "user", content: text });
        }
        if (toolResults.length > 0) {
          const lastAssistant = findLastAssistant(result);
          if (lastAssistant) {
            if (!lastAssistant.toolResults) lastAssistant.toolResults = [];
            lastAssistant.toolResults.push(...toolResults);
          }
        }
      }
    } else if (entry.type === "assistant") {
      const content = sdkMessage.content;
      if (!Array.isArray(content)) continue;
      const aggregate = {
        id: `replay-assistant-${entry.uuid}-${assistantCounter++}`,
        role: "assistant",
        content: "",
        thinking: "",
        toolUses: [],
        toolResults: [],
        done: true,
      };
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          aggregate.content += block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          aggregate.thinking += block.thinking;
        } else if (block.type === "tool_use") {
          aggregate.toolUses.push({
            id: block.id || null,
            name: block.name,
            input: block.input,
          });
        }
      }
      if (aggregate.toolUses.length === 0) delete aggregate.toolUses;
      if (aggregate.toolResults.length === 0) delete aggregate.toolResults;
      if (!aggregate.thinking) delete aggregate.thinking;
      if (aggregate.content || aggregate.toolUses) result.push(aggregate);
    }
  }
  return result;
}

function findLastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

function stripTurnContextPrefix(text) {
  if (typeof text !== "string") return "";
  // Live `handleUserMessage` prefixes user input with `<context>\n\n用户问题:\n<text>`.
  // Strip that wrapper when replaying so the panel shows the user's actual question.
  const marker = "\n\n用户问题:\n";
  const idx = text.indexOf(marker);
  if (idx >= 0) return text.slice(idx + marker.length).trim();
  return text.trim();
}

function summarizeToolResult(content) {
  if (typeof content === "string") {
    return truncate(content, 400);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return truncate(parts.join("\n"), 400);
  }
  return "";
}

function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function handleShutdown(_op) {
  shuttingDown = true;
  await closeCurrentQuery();
  rl.close();
  process.exit(0);
}

rl.on("line", (line) => {
  opQueue = opQueue
    .then(() => dispatchLine(line))
    .catch((err) => {
      const inner = err?.message || String(err);
      emitError(`Sidecar protocol error: ${inner}`, { message: inner, stack: err?.stack });
    });
});

async function dispatchLine(line) {
  let op;
  try {
    op = JSON.parse(line);
  } catch (err) {
    emitError("Invalid JSON line", { line });
    return;
  }

  if (!op || typeof op !== "object" || !op.op) {
    emitError("Missing op field", { op });
    return;
  }

  switch (op.op) {
    case "start":
      await handleStart(op);
      break;
    case "user_message":
      await handleUserMessage(op);
      break;
    case "db_response":
      await handleDbResponse(op);
      break;
    case "approval_response":
      await handleApprovalResponse(op);
      break;
    case "set_mode":
      await handleSetMode(op);
      break;
    case "set_auto_approve":
      await handleSetAutoApprove(op);
      break;
    case "list_sessions":
      await handleListSessions(op);
      break;
    case "delete_session":
      await handleDeleteSession(op);
      break;
    case "get_session_messages":
      await handleGetSessionMessages(op);
      break;
    case "interrupt":
      await handleInterrupt(op);
      break;
    case "shutdown":
      await handleShutdown(op);
      break;
    default:
      emitError("Unknown op", { op: op.op });
  }
}

rl.on("close", async () => {
  await opQueue;
  await closeCurrentQuery();
  process.exit(0);
});

// Keep the process alive while the query runs.
setInterval(() => {}, 1000);

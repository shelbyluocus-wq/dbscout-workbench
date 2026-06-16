#!/usr/bin/env node
import {
  query,
  createSdkMcpServer,
  tool,
  listSessions,
  deleteSession,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createInterface } from "node:readline";
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

/**
 * @param {string} toolName
 * @param {Record<string, any>} input
 * @param {string} permissionMode
 * @returns {Promise<{behavior: 'allow' | 'deny', message?: string}>}
 */
async function requestApproval(toolName, input, permissionMode) {
  if (permissionMode === "plan") {
    return createPermissionResult("deny", input, { message: "计划模式不会执行工具" });
  }

  // Read-only DB tools are safe to auto-approve.
  if (isAutoApprovedReadOnlyDbTool(toolName)) {
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
 * @param {object} _op
 */
async function handleListSessions(op) {
  try {
    const sessions = await listSessions({ limit: op.limit || 50 });
    emit({ ev: "session_list", sessions });
  } catch (err) {
    emitError("Failed to list sessions", { message: err.message });
  }
}

async function handleDeleteSession(op) {
  try {
    await deleteSession(op.sessionId);
    emit({ ev: "session_deleted", sessionId: op.sessionId });
  } catch (err) {
    emitError("Failed to delete session", { message: err.message });
  }
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
    case "list_sessions":
      await handleListSessions(op);
      break;
    case "delete_session":
      await handleDeleteSession(op);
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

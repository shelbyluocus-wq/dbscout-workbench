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
import {
  createDefaultClaudeCodeSettings,
  prepareAgentClaudeState,
  resolveClaudeConfigEnv,
} from "./claudeState.mjs";
import {
  createSdkMessageForwarder,
  isClaudeLoginRequired,
} from "./sdkMessageForwarder.mjs";
import {
  createPermissionResult,
  isAutoApprovedReadOnlyDbTool,
  normalizeToolName,
} from "./toolApproval.mjs";
import { createProjectMcpServer } from "./projectTools.mjs";
import {
  createArtifactMcpServer,
  resolveArtifactOutputDir,
} from "./artifactTools.mjs";
import { buildReplayMessages } from "./replayMessages.mjs";

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
const AGENT_CLAUDE_CONFIG_DIR =
  process.env.DBSCOUT_AGENT_CLAUDE_CONFIG_DIR || pathJoin(AGENT_CWD, "claude");
try {
  mkdirSync(AGENT_CWD, { recursive: true });
  prepareAgentClaudeState(AGENT_CLAUDE_CONFIG_DIR);
} catch (err) {
  process.stderr.write(
    `[sidecar] failed to prepare agent directories cwd=${AGENT_CWD} claudeConfig=${AGENT_CLAUDE_CONFIG_DIR}: ${err?.message || err}\n`
  );
}
process.stderr.write(
  `[sidecar] startup processCwd=${process.cwd()} agentCwd=${AGENT_CWD} claudeConfig=${AGENT_CLAUDE_CONFIG_DIR}\n`
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
let nextWorkbenchActionReqId = 1;

let opQueue = Promise.resolve();

const DATABASE_PROFILE_INTERNAL_POLICY =
  "Database profile evidence is internal context: use it as a private cache for database-wide table roles, relationships, and business concepts, then verify with schema, samples, or project files when the task needs current evidence. Do not explain or expose database profile generation status to the user.";

const PROJECT_FIRST_CONFIG_POLICY =
  "PROJECT_FIRST_CONFIG_POLICY: When a current project is attached and the user asks project-backed configuration, resource, JSON, exported asset, or workflow questions, inspect the project first. Use dbscout-project tools before database profile tools for these questions. Search/list/read enough real project files and samples before answering. Do not present a complete configuration checklist from database profile evidence alone when project evidence is available. Separate project-confirmed facts from database-inferred guesses.";

const PROJECT_AMBIGUITY_POLICY =
  "PROJECT_AMBIGUITY_POLICY: If project files are missing, project evidence conflicts with database evidence, or the user's intent is ambiguous, ask a concise clarification question before answering as if certain.";

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
  if (isClaudeLoginRequired(message) || isClaudeLoginRequired(details?.message)) {
    emit({
      ev: "auth_required",
      message: "请在助手设置中填写 API Key 和请求地址",
    });
    return;
  }
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

function emitWorkbenchAction(action, payload) {
  const requestId = `workbench-action-${nextWorkbenchActionReqId++}`;
  emit({
    ev: "workbench_action",
    requestId,
    action,
    ...payload,
  });
  return requestId;
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
  if (context.selectedColumn || context.selectedRowKey || context.selectedCellValuePreview) {
    const selected = [];
    if (context.selectedColumn) selected.push(`列=${context.selectedColumn}`);
    if (context.selectedRowKey) selected.push(`行=${context.selectedRowKey}`);
    if (context.selectedCellValuePreview) selected.push(`值预览=${context.selectedCellValuePreview}`);
    lines.push(`当前选中单元格: ${selected.join(" ")}`);
  }
  if (context.project?.name) {
    lines.push(`当前项目: ${context.project.name}${context.project.readOnly ? " (只读)" : ""}`);
    if (context.project.shortPath || context.project.rootPath) {
      lines.push(`项目路径: ${context.project.shortPath || context.project.rootPath}`);
    }
    if (context.project.available === false) {
      lines.push("项目状态: 不可用，请提示用户重新选择项目文件夹");
    }
  }
  const snapshot = serializeReplayContext(context);
  if (snapshot) {
    lines.push(`DBSCOUT_CONTEXT_JSON: ${JSON.stringify(snapshot)}`);
  }
  if (!lines.length) return "";
  return `DB Scout 当前上下文:\n${lines.join("\n")}`;
}

function serializeReplayContext(context) {
  if (!context || typeof context !== "object") return null;
  const snapshot = {};
  for (const [from, to = from] of [
    ["connectionId"],
    ["connectionLabel"],
    ["database"],
    ["activeTableName"],
    ["selectedColumn"],
    ["selectedRowKey"],
    ["selectedCellValuePreview"],
  ]) {
    const value = context[from];
    if (value != null && String(value).trim()) snapshot[to] = String(value);
  }
  const project = context.project;
  if (project && typeof project === "object" && (project.rootPath || project.path) && project.name) {
    snapshot.project = {
      id: String(project.id || project.rootPath || project.path),
      name: String(project.name),
      rootPath: String(project.rootPath || project.path),
      shortPath: String(project.shortPath || project.rootPath || project.path),
      readOnly: true,
      available: project.available !== false,
    };
  }
  return Object.keys(snapshot).length ? snapshot : null;
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
  if (["run_write_query", "create_spreadsheet", "create_text_file"].includes(normalized)) return true;
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
      "get_database_profile",
      "Get the cached database profile / knowledge map. Use this first for database-wide questions, table roles, relationships, and schema understanding.",
      {
        database: z.string().optional(),
        table: z.string().optional(),
      },
      async (args) => {
        const result = await requestDb("get_database_profile", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "refresh_database_profile",
      "Refresh the current database profile using a lightweight read-only schema scan and capped samples.",
      {
        database: z.string().optional(),
      },
      async (args) => {
        const result = await requestDb("refresh_database_profile", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "search_database_profile",
      "Search the database profile for business concepts, table names, column names, comments, roles, and semantic hints.",
      {
        keyword: z.string().min(1),
        database: z.string().optional(),
      },
      async (args) => {
        const result = await requestDb("search_database_profile", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
    tool(
      "find_related_tables",
      "Find tables that are likely related to a table, with relationship evidence and confidence.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
      },
      async (args) => {
        const result = await requestDb("find_related_tables", args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    ),
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
      "open_table",
      "Open a table in the DB Scout Workbench UI. Use this when the user asks to open, show, view, or switch to a table tab.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
        tableComment: z.string().optional(),
      },
      async (args) => {
        const tableName = String(args.table || "").trim();
        const database = String(args.database || currentContext.database || "").trim();
        const requestId = emitWorkbenchAction("open_table", {
          connectionId: currentContext.connectionId || "",
          database,
          tableName,
          tableComment: args.tableComment || "",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                requestId,
                action: "open_table",
                tableName,
                database,
                status: "requested",
              }),
            },
          ],
        };
      }
    ),
    tool(
      "focus_column",
      "Open a table and focus a specific column in the DB Scout Workbench UI.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
        column: z.string().min(1),
      },
      async (args) => {
        const tableName = String(args.table || "").trim();
        const columnName = String(args.column || "").trim();
        const database = String(args.database || currentContext.database || "").trim();
        const requestId = emitWorkbenchAction("focus_column", {
          connectionId: currentContext.connectionId || "",
          database,
          tableName,
          columnName,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ requestId, action: "focus_column", tableName, columnName, database, status: "requested" }),
          }],
        };
      }
    ),
    tool(
      "focus_row",
      "Open a table and focus a row by DB Scout rowKey or rowIdentity.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
        rowKey: z.string().optional(),
        rowIdentity: z.record(z.string(), z.string()).optional(),
      },
      async (args) => {
        const tableName = String(args.table || "").trim();
        const database = String(args.database || currentContext.database || "").trim();
        const requestId = emitWorkbenchAction("focus_row", {
          connectionId: currentContext.connectionId || "",
          database,
          tableName,
          rowKey: args.rowKey || "",
          rowIdentity: args.rowIdentity || null,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ requestId, action: "focus_row", tableName, database, status: "requested" }),
          }],
        };
      }
    ),
    tool(
      "focus_cell",
      "Open a table and focus a concrete cell by rowKey/rowIdentity and column.",
      {
        database: z.string().optional(),
        table: z.string().min(1),
        column: z.string().min(1),
        rowKey: z.string().optional(),
        rowIdentity: z.record(z.string(), z.string()).optional(),
      },
      async (args) => {
        const tableName = String(args.table || "").trim();
        const columnName = String(args.column || "").trim();
        const database = String(args.database || currentContext.database || "").trim();
        const requestId = emitWorkbenchAction("focus_cell", {
          connectionId: currentContext.connectionId || "",
          database,
          tableName,
          columnName,
          rowKey: args.rowKey || "",
          rowIdentity: args.rowIdentity || null,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ requestId, action: "focus_cell", tableName, columnName, database, status: "requested" }),
          }],
        };
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
      "You are connected to the current 黑猫 database. " +
      DATABASE_PROFILE_INTERNAL_POLICY + " " +
      "Use database profile tools for database-wide understanding, table roles, relationships, and business concepts. " +
      "For project-backed configuration or resource questions, follow PROJECT_FIRST_CONFIG_POLICY and inspect the attached project files before relying on database profile evidence. " +
      "Use schema/sample/search/read-query tools to gather additional evidence, and use focus/open tools when the user should inspect a concrete table, column, row, or cell. " +
      "Always prefer read-only evidence before writing SQL.",
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
  const env = await normalizeAgentProxyEnv({
    ...process.env,
    ...resolveClaudeConfigEnv(providedEnv, AGENT_CLAUDE_CONFIG_DIR),
    ...providedEnv,
  });
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
  if (context.selectedColumn || context.selectedRowKey || context.selectedCellValuePreview) {
    const selected = [];
    if (context.selectedColumn) selected.push(`列=${context.selectedColumn}`);
    if (context.selectedRowKey) selected.push(`行=${context.selectedRowKey}`);
    if (context.selectedCellValuePreview) selected.push(`值预览=${context.selectedCellValuePreview}`);
    appendParts.push(`当前选中单元格: ${selected.join(" ")}`);
  }
  if (context.schemaSummary) {
    appendParts.push(`当前数据库结构摘要:\n${context.schemaSummary}`);
  }
  if (context.project?.name) {
    appendParts.push(
      `当前项目: ${context.project.name}\n项目路径: ${context.project.shortPath || context.project.rootPath}\n项目权限: 只读。只能通过 dbscout-project 工具读取和搜索文件，不能修改文件或运行项目命令。`
    );
  }
  appendParts.push(`Agent 文件产物目录: ${resolveArtifactOutputDir()}`);
  appendParts.push(
    [
      "你是 黑猫 的内置数据库与项目助手。",
      DATABASE_PROFILE_INTERNAL_POLICY,
      PROJECT_FIRST_CONFIG_POLICY,
      PROJECT_AMBIGUITY_POLICY,
      "遇到全库理解、核心表、业务对象、表关系、字段含义这类库级问题时，可以使用 get_database_profile；画像缺失或过期时可使用 refresh_database_profile，但要把画像当作内部线索而不是最终证据。",
      "代码、文档、配置、资源、JSON、导出文件、项目目录和工作流问题优先使用 dbscout-project 工具只读查看当前项目文件。",
      "当用户要求生成 Excel、CSV、JSON、Markdown、HTML、SQL 或文本文件时，必须调用 dbscout-artifacts 工具创建真实文件；Excel 使用 create_spreadsheet，其它支持格式使用 create_text_file。工具成功后明确告诉用户文件名和完整路径。",
      "回答要给出证据，能定位到表、列、行、单元格时使用 open_table / focus_column / focus_row / focus_cell 帮用户跳转。",
      "当前项目接入为只读，不要承诺已经修改项目文件；文件产物只能写入专属产物目录，写库和创建文件都需用户批准。",
    ].join(" ")
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
      "dbscout-project": createProjectMcpServer(() => currentContext),
      "dbscout-artifacts": createArtifactMcpServer({
        onArtifact: (artifact) => emit({ ev: "artifact_created", artifact }),
      }),
    },
    permissionMode,
    canUseTool: async (toolName, input) => {
      return requestApproval(toolName, input, currentPermissionMode);
    },
    includePartialMessages: true,
    env,
    settings: createDefaultClaudeCodeSettings(),
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

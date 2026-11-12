import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFile } from "node:fs/promises";
import { serveHttp } from "./mcpHttp.mjs";
import { z } from "zod";

import { appExecutableFromArgs, ControlClient } from "./controlClient.mjs";
import { runUiActionBatch } from "./uiActionBatch.mjs";
import { executeExternalImport, previewExternalImport } from "./externalImport.mjs";
import { registerRelationTools } from "./relationTools.mjs";

const control = new ControlClient({ appExecutable: appExecutableFromArgs() });
const toolRegistrations = [];

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const uiAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function asToolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function register(name, config, handler) {
  toolRegistrations.push({
    name,
    config,
    handler: async (args) => {
      try {
        return asToolResult(await handler(args || {}));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: String(error?.message || error) }],
        };
      }
    },
  });
}

function dbTool(name, description, inputSchema) {
  register(
    name,
    { title: name, description, inputSchema, annotations: readOnlyAnnotations },
    (args) => control.request("db_tool", { func: name, args })
  );
}

const contextFields = {
  connectionId: z.string().min(1).optional().describe("连接 ID；省略时使用黑猫当前连接"),
  database: z.string().min(1).optional().describe("数据库名；省略时使用黑猫当前数据库"),
};

register(
  "get_workbench_context",
  {
    title: "获取黑猫当前界面",
    description: "黑猫 MCP 操作入口：获取当前界面/current context/state、连接、数据库、打开标签、筛选排序、选中单元格、可见行列、加载状态和权限。读取数据用 read_table_page，浏览滚动用 scroll_table，连续操作用 run_ui_actions。",
    inputSchema: z.object({}),
    annotations: readOnlyAnnotations,
  },
  () => control.request("get_context")
);

register(
  "list_connections",
  {
    title: "列出黑猫连接",
    description: "发现黑猫已配置的数据库连接及 connectionId、名称、引擎、主机和端口；不返回密码，不切换界面。跨连接操作先调用，不猜连接 ID。",
    inputSchema: z.object({}),
    annotations: readOnlyAnnotations,
  },
  () => control.request("get_connections")
);

register(
  "get_mcp_capabilities",
  {
    title: "黑猫 MCP 能力与使用入口",
    description: "发现黑猫 MCP 支持什么、如何操作、当前版本与权限。首次接入、找不到工具、调用失败或升级后优先调用。包含工具参数说明和常用流程。",
    inputSchema: z.object({}),
    annotations: readOnlyAnnotations,
  },
  async () => ({
    context: await control.request("get_context"),
    tools: toolRegistrations.map(({ name, config }) => ({
      name, description: config.description, inputSchema: z.toJSONSchema(config.inputSchema),
    })),
    workflows: {
      browse: ["get_workbench_context", "list_connections", "list_tables", "open_table", "scroll_table"],
      locate: "focus_row/focus_cell：传完整 rowIdentity；未加载时在独立主键精确筛选标签定位，保留原标签筛选。",
      read: "read_table_page：使用 nextOffset 分页；搜索结构用 search_schema，不要空关键字。",
      batch: "run_ui_actions：fast 默认无等待；demo 每步停留；compact 默认精简，full 排错。",
      createTable: "preview_create_table → 向用户展示目标、字段及警告 → create_table（相同草稿、previewSignature、confirmed=true）→ select_database / open_table；仅 MySQL 空表，不覆盖同名表，受修改表结构权限控制。",
      relations: ["get_relation_overview", "get_record_relations", "read_reference_rows", "start_reference_scan", "get_reference_scan", "search_relation_code", "read_relation_code", "test_relation_rule_page", "preview_relation_rule", "apply_relation_rule"],
      relationSafety: "只支持 MySQL。查询已有关系无需新权限；项目代码、后台扫描、修改本地规则分别授权，默认关闭。候选命中不是引用证明；区分直接、间接、动态未知和查漏失败。保存规则需用户确认；不修改游戏库，不执行配置函数。用 focus_cell + rowIdentity 打开命中行。",
    },
  })
);

dbTool(
  "get_database_profile",
  "读取覆盖全部表和字段结构的数据库知识概览，包括表职责、关系和语义提示；样本值只做有界抽取。数据库级问题优先调用。",
  z.object({ ...contextFields, table: z.string().min(1).optional() })
);
dbTool(
  "refresh_database_profile",
  "通过只读结构扫描和有限样本刷新数据库知识概览；不会修改业务数据库。",
  z.object(contextFields)
);
dbTool(
  "search_database_profile",
  "在数据库知识概览中搜索业务概念、表、字段、注释和关系。",
  z.object({ ...contextFields, keyword: z.string().min(1) })
);
dbTool(
  "find_related_tables",
  "按字段命名推测可能相关的表，仅为线索。游戏配置关联应优先 get_table_relations，逐行查引用用 read_reference_rows，漏项用 start_reference_scan。",
  z.object({ ...contextFields, table: z.string().min(1) })
);
dbTool(
  "list_databases",
  "列出当前连接可访问的数据库。",
  z.object({ connectionId: contextFields.connectionId })
);
dbTool(
  "list_tables",
  "不截断地列出数据库中的全部表和表注释。",
  z.object(contextFields)
);
dbTool(
  "describe_table",
  "返回表字段、类型、主键、可空性和注释。",
  z.object({ ...contextFields, table: z.string().min(1) })
);
dbTool(
  "sample_rows",
  "读取表的少量样本行。",
  z.object({
    ...contextFields,
    table: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional().default(12),
  })
);
dbTool(
  "read_table_page",
  "按稳定顺序分页读取表数据。单页最多 1000 行；从 offset=0 开始，并持续使用返回的 nextOffset，直到 hasMore=false，即可遍历整张表，不限制总行数。",
  z.object({
    ...contextFields,
    table: z.string().min(1),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().default(0),
    limit: z.number().int().min(1).max(1000).optional().default(1000),
  })
);
dbTool(
  "search_schema",
  "按名称或注释搜索表和字段。",
  z.object({ ...contextFields, keyword: z.string().min(1) })
);
dbTool(
  "search_values",
  "在表数据中搜索关键字，可限制到指定表。",
  z.object({
    ...contextFields,
    keyword: z.string().min(1),
    table: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional().default(20),
  })
);
dbTool(
  "run_read_query",
  "执行经过黑猫只读校验的 SELECT/SHOW/DESCRIBE/EXPLAIN 查询；不接受写 SQL，单次结果最多 1000 行。需要读取整张表时使用 read_table_page 分页遍历。",
  z.object({
    ...contextFields,
    sql: z.string().min(1),
    limit: z.number().int().min(1).max(1000).optional().default(1000),
  })
);

const explicitContextFields = {
  connectionId: z.string().min(1).describe("明确指定连接 ID，不随当前界面切换"),
  database: z.string().min(1).describe("明确指定数据库"),
};
const confirmedField = z.literal(true).describe("用户已授权本次具体操作时传 true");
const designDraft = z.object({
  tableComment: z.string(),
  columns: z.array(z.object({
    originalName: z.string().describe("现有字段原名；新增字段传空字符串"),
    name: z.string().min(1),
    type: z.string().min(1).describe("字段类型，如 int；也支持 int unsigned"),
    unsigned: z.boolean().optional().describe("数值字段无符号属性：true 不允许负数，false 改为有符号；省略时保留现有属性，新字段默认有符号。不要与 type 中的 signed/unsigned 冲突"),
    length: z.number().int().nonnegative().nullable().optional(),
    scale: z.number().int().nonnegative().nullable().optional(),
    nullable: z.boolean(),
    primaryKey: z.boolean(),
    primaryKeyOrdinal: z.number().int().positive().nullable().optional(),
    defaultMode: z.string().describe("沿用 get_table_design 返回的 defaultMode"),
    defaultValue: z.string().nullable().optional(),
    comment: z.string(),
  })).min(1).describe("完整目标字段列表；省略现有字段表示删除该字段"),
});

const createDraft = designDraft.extend({
  tableComment: z.string().max(2048),
  columns: z.array(designDraft.shape.columns.element.extend({
    originalName: z.literal("").describe("新字段必须传空字符串"),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    defaultMode: z.enum(["none", "null", "value", "expression"]),
    comment: z.string().max(1024),
  }).strict()).min(1).max(256),
}).strict();

function writeTool(name, description, inputSchema) {
  register(name, {
    title: name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, (args) => control.request("db_tool", { func: name, args }));
}

dbTool(
  "get_table_design",
  "读取完整表设计，含字段类型、长度、默认值、主键、注释及结构签名。修改结构前先读取。",
  z.object({ ...explicitContextFields, table: z.string().min(1) })
);
dbTool(
  "preview_create_table",
  "预览在指定 MySQL 数据库从零创建空表：校验字段、主键、类型和默认值，检查同名表，返回 SQL 与 previewSignature；不写数据库。每个字段 originalName 必须为空；不支持自增、外键和普通索引。先向用户展示目标库、表名、字段和警告，再确认创建。",
  z.object({ ...explicitContextFields, table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), draft: createDraft })
);
writeTool(
  "create_table",
  "创建经过预览并经用户明确授权的 MySQL 空表；需修改表结构权限。目标、草稿和 previewSignature 必须与预览一致。任何同名表或视图都拒绝，绝不覆盖；不支持任意 SQL，不自动回滚或删除。创建后使用 select_database 刷新首页，open_table 打开新表。",
  z.object({ ...explicitContextFields, table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), draft: createDraft, previewSignature: z.string().min(1), confirmed: confirmedField })
);
dbTool(
  "preview_table_design_change",
  "预览完整目标表设计，返回 SQL、数据冲突、警告和三个签名，不修改数据库。必须检查 conflicts 为空，向用户说明删除字段等影响。",
  z.object({ ...explicitContextFields, table: z.string().min(1), draft: designDraft })
);
writeTool(
  "run_write_query",
  "执行单条 INSERT/UPDATE/DELETE/REPLACE，支持新增行、修改单元格、删除行和批量修改。必须先取得用户授权并明确目标库。沿用事务和操作审计；任意 SQL 不支持一键撤销。修改表结构请使用表设计预览和应用工具。执行后可用 refresh_table 更新已打开表。",
  z.object({ ...explicitContextFields, sql: z.string().min(1), confirmed: confirmedField })
);
writeTool(
  "apply_table_design_change",
  "应用已预览并经用户授权的表设计，可增删改字段、类型、主键、默认值和注释。传入预览时完全相同的目标、草稿及三个签名；结构或草稿变更会拒绝执行。DDL 不能承诺事务回滚，重要数据应先备份。",
  z.object({
    ...explicitContextFields,
    table: z.string().min(1),
    draft: designDraft,
    schemaSignature: z.string().min(1),
    sourceSignature: z.string().min(1),
    previewSignature: z.string().min(1),
    confirmed: confirmedField,
  })
);
writeTool(
  "copy_tables",
  "复制表结构和数据到指定连接及数据库。copy 模式重名自动加后缀；overwrite 模式覆盖目标同名表，需明确授权覆盖。逐表检查返回结果中的失败项。",
  z.object({
    sourceConnectionId: z.string().min(1),
    sourceDatabase: z.string().min(1),
    tables: z.array(z.string().min(1)).min(1),
    targetConnectionId: z.string().min(1),
    targetDatabase: z.string().min(1),
    mode: z.enum(["copy", "overwrite"]).default("copy"),
    confirmed: confirmedField,
  })
);
writeTool(
  "rename_table",
  "重命名指定表，保留结构与数据；必须取得用户授权。",
  z.object({
    ...explicitContextFields,
    table: z.string().min(1),
    newName: z.string().min(1),
    confirmed: confirmedField,
  })
);
writeTool(
  "drop_tables",
  "删除指定表及其中全部数据。必须取得用户明确授权；不能一键撤销，重要数据应先备份。逐表检查 dropped 和 failed。",
  z.object({
    ...explicitContextFields,
    tables: z.array(z.string().min(1)).min(1),
    confirmed: confirmedField,
  })
);
register(
  "refresh_table",
  {
    title: "刷新黑猫中的表",
    description: "修改数据或结构后刷新黑猫中的目标表。",
    inputSchema: z.object({ ...explicitContextFields, table: z.string().min(1) }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "refresh_table", args })
);

register(
  "open_table",
  {
    title: "在黑猫中打开表",
    description: "打开指定表，隐藏窗口仅被动显示、不抢焦点；成功表示首屏数据可用，不代表动画播放完成。支持筛选排序。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      filter: z.string().optional().describe("打开后应用的筛选关键字；空字符串清除筛选"),
      filterMode: z.enum(["exact", "continuous", "fuzzy"]).optional().describe("筛选匹配方式，缺省沿用黑猫当前设置"),
      sort: z.object({ column: z.string(), descending: z.boolean().optional() }).optional().describe("打开后应用的排序"),
    }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "open_table", args })
);
register(
  "select_database",
  {
    title: "切换黑猫当前数据库",
    description: "把黑猫界面切到指定连接的数据库，等同于在侧栏选择该库。",
    inputSchema: z.object({
      connectionId: z.string().min(1).optional().describe("连接 ID；省略时使用当前连接"),
      database: z.string().min(1),
    }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "select_database", args })
);
register(
  "open_sql",
  {
    title: "在黑猫中打开 SQL 查询",
    description: "新建 SQL 查询标签并预填 SQL。run=true 时直接执行，仅限只读查询（写操作请用 run_write_query）。",
    inputSchema: z.object({
      ...contextFields,
      sql: z.string().min(1),
      run: z.boolean().optional().describe("true 时执行只读查询并返回状态与行数"),
    }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "open_sql", args })
);
register(
  "select_range",
  {
    title: "在黑猫表中选中区域",
    description: "打开表并选中起止行列构成的矩形区域；行必须在已加载页内。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      startRowKey: z.string().optional(),
      startRowIdentity: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
      endRowKey: z.string().optional(),
      endRowIdentity: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
      startColumn: z.string().min(1),
      endColumn: z.string().optional(),
    }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "select_range", args })
);
register(
  "scroll_table",
  {
    title: "滚动黑猫表格",
    description: "真实滚动表格：上下左右一屏或多屏、首行/末行；必要时加载目标窗口，不改变筛选排序。返回实际可见范围。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      direction: z.enum(["up", "down", "left", "right", "top", "bottom"]),
      screens: z.number().int().min(1).max(5).optional().default(1),
    }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "scroll_table", args })
);
register(
  "run_ui_actions",
  {
    title: "批量执行黑猫界面动作",
    description: "连续操作黑猫：按顺序执行 1-20 个动作（open_table、focus_*、scroll_table、select_database、open_sql、select_range、refresh_table、reveal_window）。遇错即停，不回滚已完成动作。默认精简结果与最终界面；demo 逐步停留，fast 不等待。",
    inputSchema: z.object({
      steps: z.array(z.object({
        action: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional().default({}),
      })).min(1).max(20),
      mode: z.enum(["fast", "demo"]).optional().default("fast"),
      pauseMs: z.number().int().min(100).max(3000).optional().default(600),
      detail: z.enum(["compact", "full"]).optional().default("compact"),
    }),
    annotations: uiAnnotations,
  },
  async ({ steps, ...options }) => runUiActionBatch(control, steps, options)
);
register(
  "focus_column",
  {
    title: "在黑猫中定位字段",
    description: "打开目标表并滚动到指定字段。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      column: z.string().min(1),
    }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "focus_column", args })
);
register(
  "focus_row",
  {
    title: "在黑猫中按主键定位行",
    description: "按完整主键 rowIdentity 定位记录；MySQL/演示库未加载时打开独立主键精确筛选标签，不清除原标签筛选。其他引擎和 rowKey 仅用于已加载行；复合主键必须完整。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      rowKey: z.string().min(1).optional(),
      rowIdentity: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
    }).refine((value) => value.rowKey || value.rowIdentity, "必须提供 rowKey 或 rowIdentity"),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "focus_row", args })
);
register(
  "focus_cell",
  {
    title: "在黑猫中定位单元格",
    description: "按完整主键 rowIdentity 定位记录和字段；MySQL/演示库未加载时在独立精确筛选标签定位，保留原视图。其他引擎和 rowKey 仅用于已加载行。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      column: z.string().min(1),
      rowKey: z.string().min(1).optional(),
      rowIdentity: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
    }).refine((value) => value.rowKey || value.rowIdentity, "必须提供 rowKey 或 rowIdentity"),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "focus_cell", args })
);
register(
  "reveal_workbench",
  {
    title: "显示黑猫窗口",
    description: "被动显示黑猫主窗口，不抢占用户正在使用的应用焦点。",
    inputSchema: z.object({}),
    annotations: uiAnnotations,
  },
  () => control.request("ui_action", { action: "reveal_window", args: {} })
);

register(
  "export_table_xlsx",
  {
    title: "导出表为 XLSX",
    description: "只读提取整张表，并在黑猫 Agent Files 目录新建 XLSX，不覆盖已有文件。",
    inputSchema: z.object({ ...contextFields, table: z.string().min(1) }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  (args) => control.request("export_table", { args })
);

register(
  "preview_import_xlsx",
  {
    title: "预览 XLSX 整表导入",
    description: "读取本地 XLSX、校验字段和主键并生成 15 分钟有效的预览，不修改数据库。必须先预览才能导入。",
    inputSchema: z.object({
      ...contextFields,
      table: z.string().min(1),
      sourcePath: z.string().min(1),
      sheet: z.string().min(1).optional(),
    }),
    annotations: readOnlyAnnotations,
  },
  (args) => previewExternalImport(control, args)
);
register(
  "import_table_xlsx",
  {
    title: "确认 XLSX 整表导入",
    description: "执行已预览的整表覆盖。必须 confirmReplace=true；黑猫会先生成原表数据的 XLSX 备份，备份失败则不会修改数据库。",
    inputSchema: z.object({
      previewId: z.string().uuid(),
      confirmReplace: z.boolean().describe("用户明确确认整表覆盖后必须为 true"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  (args) => executeExternalImport(control, args)
);

registerRelationTools(register, control);

function createServer() {
  const server = new McpServer({ name: "blackcat", version: "1.0.0" });
  for (const registration of toolRegistrations) {
    server.registerTool(registration.name, registration.config, registration.handler);
  }
  return server;
}

const httpConfigIndex = process.argv.indexOf("--http-config");
const transportServer = httpConfigIndex < 0
  ? serveStdio(createServer)
  : await serveHttp(createServer, JSON.parse(await readFile(process.argv[httpConfigIndex + 1], "utf8")));

if (httpConfigIndex >= 0) {
  process.stdout.write("ready\n");
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    control.close();
    await transportServer.close();
    process.exit(0);
  });
}

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { appExecutableFromArgs, ControlClient } from "./controlClient.mjs";
import { executeExternalImport, previewExternalImport } from "./externalImport.mjs";

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
    description: "返回黑猫当前连接、数据库、已打开表、当前页和已加载字段。",
    inputSchema: z.object({}),
    annotations: readOnlyAnnotations,
  },
  () => control.request("get_context")
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
  "查找可能与目标表相关的表，并返回关系依据。",
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
    type: z.string().min(1),
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
    description: "把黑猫窗口切到前台并打开指定表；成功响应表示首屏数据已经可用。",
    inputSchema: z.object({ ...contextFields, table: z.string().min(1) }),
    annotations: uiAnnotations,
  },
  (args) => control.request("ui_action", { action: "open_table", args })
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
    title: "在黑猫中定位已加载行",
    description: "打开表并定位当前已加载页中的行；rowIdentity 使用主键字段对象。",
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
    description: "打开表并定位当前已加载页中的指定行和字段。",
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
    description: "显示并聚焦黑猫主窗口。",
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

function createServer() {
  const server = new McpServer({ name: "blackcat", version: "1.0.0" });
  for (const registration of toolRegistrations) {
    server.registerTool(registration.name, registration.config, registration.handler);
  }
  return server;
}

const stdioServer = serveStdio(createServer);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    control.close();
    await stdioServer.close();
    process.exit(0);
  });
}

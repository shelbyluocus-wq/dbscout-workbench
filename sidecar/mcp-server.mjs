import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { appExecutableFromArgs, ControlClient } from "./controlClient.mjs";
import { executeExternalImport, previewExternalImport } from "./externalImport.mjs";

const control = new ControlClient({ appExecutable: appExecutableFromArgs() });
const server = new McpServer({ name: "blackcat", version: "1.0.0" });

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
  server.registerTool(name, config, async (args) => {
    try {
      return asToolResult(await handler(args || {}));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: String(error?.message || error) }],
      };
    }
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
  "读取数据库知识概览，包括表职责、关系和语义提示。数据库级问题优先调用。",
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
  "列出数据库中的表和注释。",
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
  "执行经过黑猫只读校验的 SELECT/SHOW/DESCRIBE/EXPLAIN 查询；不接受写 SQL，结果最多 1000 行。",
  z.object({
    ...contextFields,
    sql: z.string().min(1),
    limit: z.number().int().min(1).max(1000).optional().default(1000),
  })
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

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    control.close();
    await server.close();
    process.exit(0);
  });
}

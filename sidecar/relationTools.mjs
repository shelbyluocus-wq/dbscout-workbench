import { z } from "zod";

export function registerRelationTools(register, control) {
  const scope = { connectionId: z.string().min(1), database: z.string().min(1) };
  const identity = z.record(z.string(), z.union([z.string(), z.number().int().safe()]));
  const target = { ...scope, table: z.string().min(1), rowIdentity: identity };
  const draft = z.object({
    sourceTable: z.string().min(1), sourceColumn: z.string().min(1),
    targetTable: z.string().min(1), targetColumn: z.string().min(1),
    parser: z.union([
      z.object({ type: z.literal("keys"), delimiter: z.enum([",", "|", "json"]) }),
      z.object({ type: z.literal("token"), delimiter: z.enum([",", "|"]), index: z.number().int().min(0).max(64) }),
      z.object({ type: z.literal("prefix"), prefix: z.string().min(1).max(64) }),
      z.object({ type: z.literal("jsonPaths"), paths: z.array(z.string().min(1).max(256)).min(1).max(8), exclude: z.array(z.string()).optional() }),
      z.object({ type: z.literal("json"), member: z.string().min(1), selector: z.object({ member: z.string(), value: z.string() }).nullable().optional(), exclude: z.array(z.string()).optional(), ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).optional(), outsideRanges: z.boolean().optional() }),
      z.object({ type: z.literal("condition"), prefix: z.string().min(1).max(64).nullable().optional(), valuePrefix: z.string().min(1).max(64).nullable().optional() }),
    ]).nullable().default(null),
    sourceConstraints: z.array(z.object({ column: z.string().min(1), values: z.array(z.string().min(1).max(256)).min(1).max(50) })).max(8).default([]),
    evidence: z.string().min(1).max(4000), codePaths: z.array(z.string().min(1).max(2048)).max(8).default([]), enabled: z.boolean().default(true),
  });
  function tool(name, description, schema, write = false) {
    register(name, { title: name, description, inputSchema: z.object(schema), annotations: {
      readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: false,
    } }, (args) => control.request("db_tool", { func: name, args }));
  }
  tool("get_relation_overview", "读取黑猫真正的配置关联引擎概览、客户端绑定、覆盖缺口和刷新进度，不是按字段命名猜相关表。关联问题先调用。这组关联工具目前只支持 MySQL。", scope);
  tool("get_table_relations", "读取指定表引用/被引用的字段关系、解析规则、注释/代码证据和未覆盖原因。返回 revision；继续用 read_reference_rows 读取具体记录。", { ...scope, table: z.string().min(1) });
  tool("get_record_relations", "按完整主键读取当前记录的引用目标，同时返回双向关联定义、状态与覆盖缺口；不提前全库计数。目标存在不等于引用已确认。仅直接引用；间接使用需要逐层追踪，保留链路并去重防环。", target);
  tool("read_reference_rows", "按关联 ID 和目标记录完整主键分页读取真正引用它的源记录，默认返回主键、名称和命中单元格预览；includeRow=true 才返回完整行。valueTruncated 表示需重读。候选/过期/未知关联不会伪报零。非唯一目标标为字段引用，不能认定唯一行。数据实时读取非事务快照。", {
    ...scope, relationId: z.string().min(1), rowIdentity: identity,
    revision: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().safe().default(0), limit: z.number().int().min(1).max(200).default(50), includeRow: z.boolean().default(false),
  });
  tool("get_relation_rules", "分页读取当前库本地 AI 辅助规则；relationId 可精确定位，includeHistory=true 才返回最近 100 次变更（含上一个版本）。回退时取历史 draft 重新预览并确认；不会自动撤回人工决定。代码依据受项目权限保护。", { ...scope, relationId: z.string().min(1).optional(), offset: z.number().int().min(0).max(500).default(0), limit: z.number().int().min(1).max(200).default(50), includeHistory: z.boolean().default(false) });
  tool("read_relation_code", "只读绑定客户端的代码片段（按行分页）；需读取项目代码权限。只限绑定目录、敏感文件拒绝、敏感行隐藏；不执行代码。", { ...scope, path: z.string().min(1), startLine: z.number().int().min(1).max(1000000).default(1), limit: z.number().int().min(1).max(200).default(100) });
  tool("search_relation_code", "在绑定客户端中搜索代码依据，分页扫描并返回文件/行号/文件指纹；需项目只读权限。检查 hasMore、errors、manifestTruncated，不能把截断当查全。", {
    ...scope, keyword: z.string().min(1).max(200), cursor: z.object({ manifest: z.string(), query: z.string(), file: z.number().int().nonnegative().safe(), line: z.number().int().nonnegative().safe(), fileHash: z.string().optional() }).optional(),
  });
  tool("start_reference_scan", "后台逐表逐页搜索某记录字段值的完整字面值及编码数字（如 G1001_5），查找已知关联之外的漏项候选。需后台扫描权限；默认全库，可选 tables。命中不等于引用，不执行函数。返回任务 ID 后轮询进度，翻页和表浏览优先。", { ...target, column: z.string().min(1), tables: z.array(z.string().min(1)).min(1).max(2000).optional() }, true);
  tool("get_reference_scan", "读取扫描进度、已查/未查/失败表及候选结果。after 使用 nextCursor。最多缓冲 5000 行或 8MB 后暂停；结果取走后可继续。单行单元格和预览有明确截断标记，按主键重读。任务仅当前进程内有效，完整遍历不证明动态引用齐全。", { ...scope, scanId: z.string().uuid(), after: z.number().int().nonnegative().safe().optional(), limit: z.number().int().min(1).max(200).default(100) });
  tool("control_reference_scan", "暂停、继续、取消或删除扫描。resume 可传 discardThrough 清理已取走结果；不要丢弃尚未读取的结果。暂停/取消无需扫描权限，继续需要。", { ...scope, scanId: z.string().uuid(), action: z.enum(["pause", "resume", "cancel", "forget"]), discardThrough: z.number().int().nonnegative().safe().optional() }, true);
  tool("preview_relation_rule", "验证 AI 提出的本地关联规则：检查表字段，解析 sampleOffset 开始的 200 行，返回提取值和未解析数、旧规则、15 分钟有效预览。需扫描权限；codePaths 另需项目只读权限。仅样本验证，不代表全表、目标存在或语义已证明；必须展示依据和风险给用户。只支持指向单列主键；parser=null 为标量；enabled=false 停用本地规则并恢复自动识别。仅指定代码文件变化可追踪。", { ...scope, draft, sampleOffset: z.number().int().nonnegative().safe().default(0) });
  tool("apply_relation_rule", "确认已预览的关联规则，需修改本地关联规则权限和用户明确授权。校验结构/样本/代码/规则版本未变化，保留历史，更新软件关系图；不写业务库，不覆盖人工审核结论。", { ...scope, previewId: z.string().uuid(), confirmed: z.literal(true) }, true);
  tool("test_relation_rule_page", "用候选规则分页解析真实源表，不保存规则，不执行配置函数。返回每行提取的 ID、是否适用、无法解析状态。用 nextOffset 遍历，不能把样本正确当语义已验证；需后台扫描权限。", { ...scope, draft, offset: z.number().int().nonnegative().safe().default(0), limit: z.number().int().min(1).max(200).default(50) });
}

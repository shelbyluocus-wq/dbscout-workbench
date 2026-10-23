// Produce a reviewable per-table inventory, without copying production rows.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [directory, baselineFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error("Expected export directory, baseline audit JSON, output Markdown");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const audit = await read(join(directory, "relations-audit.json"));
const exported = await read(join(directory, "audit.json"));
const baseline = await read(baselineFile);
const manifest = await readFile(join(directory, "client-manifest.json"));
const previous = new Set(baseline.relations.map((entry) => entry.relation.id));
const current = new Set(audit.relations.map((entry) => entry.relation.id));
const added = audit.relations.filter((entry) => !previous.has(entry.relation.id));
const removed = baseline.relations.filter((entry) => !current.has(entry.relation.id));
const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
const cell = (value) => String(value).replaceAll("|", " / ").replace(/[\r\n]+/g, " ");
const rows = exported.tables.reduce((total, table) => total + table.rowCount, 0);
const columns = exported.tables.reduce((total, table) => total + table.columns.length, 0);
const lines = ["# 决胜2 4区字段关联逐表核查", "",
  `- 导出时间：${exported.startedAt} 至 ${exported.finishedAt}。`,
  `- 范围：${exported.database}，${audit.tables}张表、${columns}列、${rows}行；读取错误${exported.errors.length}项。`,
  `- 关系：${audit.relations.length}条；对比本轮优化前的同库基线${baseline.relations.length}条，新增${added.length}条、移除${removed.length}条。同一条关系的解析方式修正不重复计入新增。`,
  `- 客户端：扫描${audit.scan.files}个源文件；本次只读副本清单SHA-256：\`${createHash("sha256").update(manifest).digest("hex")}\`。`,
  "- 数据库正在使用中，导出不是事务冻结快照；核对期间月影登楼两张表被清空，已重读后重跑。客户端也在更新，验收扫描使用本次只读副本，未修改客户端。",
  "- 核查范围是每张表的结构、注释、客户端静态读取和完整导出数据。遍历全部表不等于证明全部动态玩法规则；函数、运行时参数和复合上下文明确保留为待核查。", "",
  "## 重点修正", "",
  "- 宝箱：BoxID引用物品ID；ItemCfg按物品/核心单位拆分，能够反查产出该物品的宝箱。",
  "- 来源：逗号来源列表逐项匹配；宝箱来源按Provence分类；Param只取客户端使用的第一项，商店与宝箱按Type隔离。",
  "- 活动：模板参数按Kind和CondTypeID限定；限时道具参数仅在对应活动生效；旧活动表名和反向注释不再产生错误引用。",
  "- 格式：阵容嵌套字段、套装二元组、条件前缀、奖励特殊标记各自解析；不把数量、星级、权重、占位P或描述文本当ID。",
  "- 一致性：正向目标、反向数量、展开记录及跳转筛选共用解析和类型限制；反查不再静默截断300条。", "",
  "## 逐表清单", "",
  "出/入是字段关系数，不是记录数；增/删仅统计本表作为引用方。待解析是行×关系次数；缺目标也是引用次数，不直接判为配置错误。", "",
  "| 表 | 行数 | 出 / 入 | 增 / 删 | 待解析 / 缺目标 | 核查备注 |",
  "| --- | ---: | ---: | ---: | ---: | --- |"];
const tableDetails = [];
for (const table of audit.tableChecks) {
  const entries = audit.relations.filter((entry) => entry.relation.sourceTable === table.table);
  const source = exported.tables.find((entry) => entry.tableName === table.table);
  const dynamicColumns = source.columns.filter((column) => Object.values(column.shapes || {}).some((shape) =>
    shape.samples?.some((sample) => /^function\b/.test(String(sample).trim())))).map((column) => column.columnName);
  const unsupported = table.coverage.gaps.find((gap) => gap.code === "unsupportedFields")?.columns || [];
  const untraced = table.coverage.gaps.find((gap) => gap.code === "untracedLookups")?.count || 0;
  const notes = [];
  if (!table.outgoing && !table.incoming) notes.push("未建立静态表间关系");
  if (table.coverage.gaps.some((gap) => gap.code === "notUsedByClient")) notes.push("未发现客户端读取（不代表无服务端用途）");
  if (untraced) notes.push(`${untraced}处读取来源待追踪`);
  if (unsupported.length) notes.push(`不支持格式：${unsupported.join(", ")}`);
  if (dynamicColumns.length) notes.push(`含函数：${dynamicColumns.join(", ")}`);
  const additions = added.filter((entry) => entry.relation.sourceTable === table.table);
  const removals = removed.filter((entry) => entry.relation.sourceTable === table.table);
  const missing = entries.reduce((n, entry) => n + Object.values(entry.missing).reduce((a, b) => a + b, 0), 0);
  lines.push(`| \`${table.table}\` | ${table.rows} | ${table.outgoing} / ${table.incoming} | ${additions.length} / ${removals.length} | ${sum(entries, "unparsed")} / ${missing} | ${cell(notes.join("；") || "已逐列检查现有证据")} |`);
  tableDetails.push({ table: table.table, rows: table.rows, columns: table.columns,
    outgoing: entries.map((entry) => entry.relation), incoming: audit.relations.filter((entry) => entry.relation.targetTable === table.table).map((entry) => entry.relation.id),
    added: additions.map((entry) => entry.relation.id), removed: removals.map((entry) => entry.relation.id),
    notes, unresolved: entries.filter((entry) => entry.unparsed || Object.keys(entry.missing).length).map((entry) => ({
      relation: entry.relation.id, unparsed: entry.unparsed, missingKeyCount: Object.keys(entry.missing).length,
      missingOccurrences: Object.values(entry.missing).reduce((a, b) => a + b, 0) })) });
}
lines.push("", "## 本轮新增关系", "");
for (const entry of added) lines.push(`- \`${entry.relation.id}\`${entry.relation.sourceConstraints?.length ? `，仅限 ${entry.relation.sourceConstraints.map((guard) => `${guard.column}=${guard.values.join("/")}`).join(" 且 ")}` : ""}`);
lines.push("", "## 移除的旧推断", "", "包含被引用说明误读成正向引用、数量误作ID、描述参数误作ID及旧表名。人工确认历史不删除；失去依据的人工关系显示待复核且不继续错误匹配。", "");
for (const entry of removed) lines.push(`- \`${entry.relation.id}\``);
lines.push("", "## 尚未证明的部分", "",
  "- 动态函数不执行；函数内部可能存在更多引用，不以零关系或零命中宣告没有引用。",
  "- 技能组内SkillID、同GroupID的前置星点、赛季城池等需要复合上下文，不能用一个相同数字替代完整条件。",
  "- 没有客户端读取的表可能由服务端或工具使用，未据此删除表或判定废弃。",
  "- 缺目标只说明本次导出的对应键未找到，可能是旧配置、示例数据或变化中的配置；未改库、未补造数据。",
  "- UI验收使用私有导出回放和当前前端；数据库谓词另行在4区只读执行。不是对已安装旧版桌面应用的验收。", "");
await writeFile(outputFile, lines.join("\n"));
await writeFile(join(directory, "table-review.json"), JSON.stringify(tableDetails, null, 2));
console.log(JSON.stringify({ tables: tableDetails.length, rows, columns, relations: current.size, added: added.length, removed: removed.length, outputFile }));

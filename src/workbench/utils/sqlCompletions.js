export const SQL_KEYWORDS = Object.freeze([
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
  "ON", "AS", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "DISTINCT",
  "UNION", "UNION ALL", "WITH", "CASE", "WHEN", "THEN", "ELSE", "END",
  "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE",
  "ALTER TABLE", "DROP TABLE", "TRUNCATE TABLE", "CREATE INDEX", "DROP INDEX",
  "EXPLAIN", "SHOW", "DESCRIBE", "USE", "BEGIN", "COMMIT", "ROLLBACK",
]);

export const SQL_FUNCTIONS = Object.freeze([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "NOW", "CURDATE", "DATE_FORMAT",
  "COALESCE", "IFNULL", "CONCAT", "LOWER", "UPPER", "ROUND", "JSON_EXTRACT",
]);

export const SQL_SNIPPETS = Object.freeze([
  {
    label: "SELECT query",
    displayLabel: "SELECT ... FROM ...",
    detail: "查询模板",
    template: "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}\nLIMIT ${4:100};",
  },
  {
    label: "INSERT INTO row",
    displayLabel: "INSERT INTO ... VALUES ...",
    detail: "新增模板",
    template: "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});",
  },
  {
    label: "UPDATE safe row",
    displayLabel: "UPDATE ... SET ... WHERE ...",
    detail: "安全更新模板",
    template: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};",
  },
  {
    label: "DELETE safe row",
    displayLabel: "DELETE FROM ... WHERE ...",
    detail: "安全删除模板",
    template: "DELETE FROM ${1:table}\nWHERE ${2:condition};",
  },
]);

const IDENTIFIER_CHARS = "\\w$\\u0080-\\uFFFF";
const IDENTIFIER_SOURCE = `(?:\`(?:\`\`|[^\`])+\`|[A-Za-z_$\\u0080-\\uFFFF][${IDENTIFIER_CHARS}]*)`;
const RESERVED_ALIAS_WORDS = new Set([
  ...SQL_KEYWORDS.flatMap((keyword) => keyword.split(" ")),
  "CROSS", "FULL", "OUTER", "NATURAL", "STRAIGHT_JOIN", "USING", "WINDOW",
]);
const STARTER_KEYWORDS = new Set([
  "SELECT", "WITH", "INSERT INTO", "UPDATE", "DELETE FROM", "EXPLAIN", "SHOW",
  "DESCRIBE", "USE", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
]);
const EXPRESSION_KEYWORDS = new Set([
  "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE",
  "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END", "GROUP BY", "ORDER BY",
  "HAVING", "LIMIT", "OFFSET", "AS", "DISTINCT",
]);
const EXPRESSION_CLAUSES = new Set([
  "SELECT", "WHERE", "ON", "HAVING", "SET", "VALUES", "WHEN", "THEN", "ELSE",
]);
const SECTION = Object.freeze({
  templates: Object.freeze({ name: "常用模板", rank: 0 }),
  current: Object.freeze({ name: "当前语句", rank: 1 }),
  columns: Object.freeze({ name: "字段", rank: 2 }),
  tables: Object.freeze({ name: "表", rank: 3 }),
  databases: Object.freeze({ name: "数据库", rank: 4 }),
  functions: Object.freeze({ name: "函数", rank: 5 }),
  keywords: Object.freeze({ name: "关键字", rank: 6 }),
});

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function unquoteIdentifier(value) {
  const text = String(value || "").trim();
  return text.startsWith("`") && text.endsWith("`")
    ? text.slice(1, -1).replaceAll("``", "`")
    : text;
}

function scanSql(source, cursor) {
  const sql = String(source ?? "");
  const limit = Math.max(0, Math.min(sql.length, Number(cursor) || 0));
  let masked = "";
  let state = "normal";
  let index = 0;
  while (index < limit) {
    const char = sql[index];
    const next = sql[index + 1];
    if (state === "normal") {
      if (char === "'") {
        state = "single";
        masked += " ";
      } else if (char === '"') {
        state = "double";
        masked += " ";
      } else if (char === "`") {
        state = "backtick";
        masked += " ";
      } else if (char === "#" || (char === "-" && next === "-" && /\s|$/.test(sql[index + 2] || ""))) {
        state = "line-comment";
        masked += " ";
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        masked += "  ";
        index += 1;
      } else masked += char;
    } else if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      masked += char === "\n" ? "\n" : " ";
      if (char === "\\" && index + 1 < limit) {
        masked += " ";
        index += 1;
      } else if (char === quote) {
        if (next === quote && index + 1 < limit) {
          masked += " ";
          index += 1;
        } else state = "normal";
      }
    } else if (state === "backtick") {
      if (char === "`") {
        if (next === "`" && index + 1 < limit) {
          masked += "  ";
          index += 1;
        } else {
          masked += " ";
          state = "normal";
        }
      } else masked += char;
    } else if (state === "line-comment") {
      masked += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "normal";
    } else if (state === "block-comment") {
      masked += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        masked += " ";
        index += 1;
        state = "normal";
      }
    }
    index += 1;
  }
  return { masked, state, cursor: limit };
}

function parseRelations(statement) {
  const relationPattern = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${IDENTIFIER_SOURCE})(?:\\s*\\.\\s*(${IDENTIFIER_SOURCE}))?(?:\\s+(?:AS\\s+)?(${IDENTIFIER_SOURCE}))?`,
    "giu",
  );
  const relations = [];
  for (const match of statement.matchAll(relationPattern)) {
    const database = match[2] ? unquoteIdentifier(match[1]) : "";
    const table = unquoteIdentifier(match[2] || match[1]);
    const aliasCandidate = unquoteIdentifier(match[3]);
    const alias = aliasCandidate && !RESERVED_ALIAS_WORDS.has(aliasCandidate.toUpperCase())
      ? aliasCandidate
      : "";
    if (!table) continue;
    const key = `${normalize(database)}\u001f${normalize(table)}\u001f${normalize(alias)}`;
    if (!relations.some((item) => item.key === key)) relations.push({ key, database, table, alias });
  }
  return relations;
}

function lastClause(masked) {
  const tokens = [...masked.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)];
  return tokens.at(-1)?.[0]?.toUpperCase() || "";
}

export function getSqlCompletionContext(source, cursor = String(source ?? "").length) {
  const sql = String(source ?? "");
  const scan = scanSql(sql, cursor);
  const blocked = ["single", "double", "line-comment", "block-comment"].includes(scan.state);
  if (blocked) {
    return { kind: "blocked", from: scan.cursor, prefix: "", qualifier: "", relations: [], auto: false };
  }

  const statementStart = scan.masked.lastIndexOf(";") + 1;
  const fullScan = scan.cursor === sql.length ? scan : scanSql(sql, sql.length);
  const nextStatementEnd = fullScan.masked.indexOf(";", scan.cursor);
  const statementEnd = nextStatementEnd < 0 ? sql.length : nextStatementEnd;
  const rawStatement = sql.slice(statementStart, scan.cursor);
  const maskedStatement = scan.masked.slice(statementStart);
  const fullMaskedStatement = fullScan.masked.slice(statementStart, statementEnd);
  const wordMatch = new RegExp(`[${IDENTIFIER_CHARS}]*$`, "u").exec(rawStatement);
  const prefix = wordMatch?.[0] || "";
  const from = scan.cursor - prefix.length;
  const relativeFrom = from - statementStart;
  const beforeWord = maskedStatement.slice(0, relativeFrom);
  const rawBeforeWord = rawStatement.slice(0, relativeFrom);
  const qualifierMatch = new RegExp(`(${IDENTIFIER_SOURCE})\\s*\\.\\s*$`, "iu").exec(rawBeforeWord);
  const qualifier = qualifierMatch ? unquoteIdentifier(qualifierMatch[1]) : "";
  const relations = parseRelations(fullMaskedStatement);

  if (qualifier) {
    return { kind: "qualified", from, prefix, qualifier, relations, auto: true };
  }
  if (/\b(?:FROM|JOIN|UPDATE|INTO|TABLE|DESC|DESCRIBE)\s*$/iu.test(beforeWord)
    || /\bFROM\s+[^;]*,\s*$/iu.test(beforeWord)) {
    return { kind: "relation", from, prefix, qualifier: "", relations, auto: true };
  }
  if (/\bUSE\s*$/iu.test(beforeWord)) {
    return { kind: "database", from, prefix, qualifier: "", relations, auto: true };
  }
  if (!beforeWord.trim()) {
    return { kind: "statement", from, prefix, qualifier: "", relations, auto: false };
  }

  const clause = lastClause(beforeWord);
  const expressionTrigger = EXPRESSION_CLAUSES.has(clause)
    || /\b(?:GROUP|ORDER)\s+BY\s*$/iu.test(beforeWord)
    || /[,(]\s*$/u.test(beforeWord);
  if (expressionTrigger) {
    return { kind: "expression", from, prefix, qualifier: "", relations, clause, auto: true };
  }
  return { kind: "general", from, prefix, qualifier: "", relations, clause, auto: false };
}

function tableNameOf(table) {
  return String(table?.table_name || table?.tableName || table?.name || "").trim();
}

function columnNameOf(column) {
  return String(column?.column_name || column?.columnName || column?.name || "").trim();
}

function columnTypeOf(column) {
  return String(column?.column_type || column?.columnType || column?.data_type || column?.dataType || "").trim();
}

function schemaTables(schema) {
  return (Array.isArray(schema) ? schema : []).map((table) => ({
    raw: table,
    name: tableNameOf(table),
    comment: String(table?.table_comment || table?.tableComment || "").trim(),
    columns: (Array.isArray(table?.columns) ? table.columns : []).map((column) => ({
      raw: column,
      name: columnNameOf(column),
      type: columnTypeOf(column),
      comment: String(column?.column_comment || column?.columnComment || "").trim(),
      primary: Boolean(column?.is_primary_key || column?.isPrimaryKey),
      nullable: Boolean(column?.is_nullable || column?.isNullable),
    })).filter((column) => column.name),
  })).filter((table) => table.name);
}

function keywordOptions(keywords = SQL_KEYWORDS, { boost = 0 } = {}) {
  return keywords.map((label) => ({
    label,
    type: "keyword",
    detail: "关键字",
    section: SECTION.keywords,
    boost,
  }));
}

function functionOptions() {
  return SQL_FUNCTIONS.map((label) => ({
    label,
    type: "function",
    detail: "函数",
    section: SECTION.functions,
    template: `${label}(\${})`,
  }));
}

function tableOptions(tables, { section = SECTION.tables, boost = 0 } = {}) {
  return tables.map((table) => ({
    label: table.name,
    type: "class",
    detail: "表",
    info: table.comment || undefined,
    section,
    boost,
  }));
}

function databaseOptions(databases, { boost = 0 } = {}) {
  return [...new Set((Array.isArray(databases) ? databases : []).map((item) => String(item || "").trim()).filter(Boolean))]
    .map((label) => ({
      label,
      type: "namespace",
      detail: "数据库",
      section: SECTION.databases,
      boost,
    }));
}

function columnOption(column, { label = column.name, source = "字段", boost = 0, section = SECTION.columns } = {}) {
  const traits = [column.type, column.primary ? "主键" : "", column.nullable ? "可空" : ""].filter(Boolean);
  const info = [traits.join(" · "), column.comment].filter(Boolean).join("\n");
  return {
    label,
    type: column.primary ? "property constant" : "property",
    detail: [source, column.type].filter(Boolean).join(" · "),
    info: info || undefined,
    section,
    boost,
  };
}

function relatedColumnOptions(tables, context) {
  const byName = new Map(tables.map((table) => [normalize(table.name), table]));
  const resolved = context.relations.map((relation) => ({
    relation,
    table: byName.get(normalize(relation.table)),
  })).filter((item) => item.table);
  const qualify = resolved.length > 1;
  return resolved.flatMap(({ relation, table }) => {
    const source = relation.alias || table.name;
    return table.columns.map((column) => columnOption(column, {
      label: qualify ? `${source}.${column.name}` : column.name,
      source,
      boost: 30,
      section: SECTION.current,
    }));
  });
}

function allColumnOptions(tables) {
  const qualify = tables.length > 1;
  return tables.flatMap((table) => table.columns.map((column) => columnOption(column, {
    label: qualify ? `${table.name}.${column.name}` : column.name,
    source: table.name,
  })));
}

function relationAliasOptions(context) {
  return context.relations.filter((relation) => relation.alias).map((relation) => ({
    label: relation.alias,
    type: "namespace",
    detail: `${relation.table} 的别名`,
    section: SECTION.current,
    boost: 35,
  }));
}

function starterOptions() {
  const snippets = SQL_SNIPPETS.map((snippet, index) => ({
    ...snippet,
    type: "keyword",
    section: SECTION.templates,
    boost: 50 - index * 2,
  }));
  return [...snippets, ...keywordOptions(SQL_KEYWORDS.filter((keyword) => STARTER_KEYWORDS.has(keyword)), { boost: 20 })];
}

function uniqueOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    const key = `${option.label}\u001f${option.detail || ""}\u001f${option.section?.name || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildSqlCompletionOptions(schema = [], databases = [], context = { kind: "general", prefix: "", relations: [] }) {
  const tables = schemaTables(schema);
  if (context.kind === "blocked") return [];
  if (context.kind === "statement") return starterOptions();
  if (context.kind === "database") return databaseOptions(databases, { boost: 40 });
  if (context.kind === "relation") {
    return [...tableOptions(tables, { section: SECTION.current, boost: 40 }), ...databaseOptions(databases, { boost: 20 })];
  }
  if (context.kind === "qualified") {
    if (context.database && normalize(context.database) === normalize(context.qualifier)) {
      return tableOptions(tables, { section: SECTION.current, boost: 40 });
    }
    const relation = context.relations.find((item) => normalize(item.alias || item.table) === normalize(context.qualifier));
    const table = tables.find((item) => normalize(item.name) === normalize(relation?.table || context.qualifier));
    return table ? table.columns.map((column) => columnOption(column, {
      source: relation?.alias || table.name,
      boost: 40,
      section: SECTION.current,
    })) : [];
  }
  if (context.kind === "expression") {
    const related = relatedColumnOptions(tables, context);
    const fallback = !related.length && (String(context.prefix || "").length >= 2 || tables.length <= 5)
      ? allColumnOptions(tables)
      : [];
    const expressions = keywordOptions(SQL_KEYWORDS.filter((keyword) => EXPRESSION_KEYWORDS.has(keyword)), { boost: 5 });
    return uniqueOptions([
      ...relationAliasOptions(context),
      ...related,
      ...fallback,
      { label: "*", type: "constant", detail: "所有字段", section: SECTION.current, boost: 25 },
      ...functionOptions(),
      ...expressions,
    ]);
  }

  const includeColumns = String(context.prefix || "").length >= 2 || tables.length <= 5;
  return uniqueOptions([
    ...keywordOptions(),
    ...functionOptions(),
    ...databaseOptions(databases),
    ...tableOptions(tables),
    ...(includeColumns ? allColumnOptions(tables) : []),
  ]);
}

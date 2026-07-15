const READ_KEYWORDS = new Set([
  "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES",
]);
const TRANSACTION_KEYWORDS = new Set([
  "BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
]);
const WRITE_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "CALL", "LOAD",
]);
const HIGH_RISK_KEYWORDS = new Set([
  "DROP", "TRUNCATE", "ALTER", "CREATE", "RENAME", "GRANT", "REVOKE",
  "OPTIMIZE", "REPAIR", "ANALYZE",
]);
const CTE_OPERATION_KEYWORDS = new Set([
  "SELECT", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE",
]);

function trimRange(sql, from, to) {
  while (from < to && /\s/.test(sql[from])) from += 1;
  while (to > from && /\s/.test(sql[to - 1])) to -= 1;
  return { from, to, text: sql.slice(from, to) };
}

function isLineStart(sql, index) {
  return index === 0 || sql[index - 1] === "\n" || sql[index - 1] === "\r";
}

function delimiterDirective(sql, index) {
  if (!isLineStart(sql, index)) return null;
  const lineEnd = sql.indexOf("\n", index);
  const end = lineEnd < 0 ? sql.length : lineEnd + 1;
  const line = sql.slice(index, lineEnd < 0 ? sql.length : lineEnd);
  const match = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
  return match ? { delimiter: match[1], end } : null;
}

/**
 * Split SQL without treating delimiters inside strings/comments as boundaries.
 * MySQL DELIMITER directives are understood, so routine bodies remain intact.
 */
export function splitSqlStatements(source) {
  const sql = String(source ?? "");
  const statements = [];
  let delimiter = ";";
  let start = 0;
  let index = 0;
  let state = "normal";

  const push = (end) => {
    const statement = trimRange(sql, start, end);
    if (statement.text) statements.push(statement);
  };

  while (index < sql.length) {
    if (state === "normal") {
      const directive = delimiterDirective(sql, index);
      if (directive) {
        push(index);
        delimiter = directive.delimiter;
        index = directive.end;
        start = index;
        continue;
      }
      if (sql.startsWith(delimiter, index)) {
        push(index);
        index += delimiter.length;
        start = index;
        continue;
      }
      const char = sql[index];
      const next = sql[index + 1];
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "backtick";
      else if (char === "#") state = "line-comment";
      else if (char === "-" && next === "-" && /\s|$/.test(sql[index + 2] || "")) {
        state = "line-comment";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        index += 1;
      }
    } else if (state === "single" || state === "double" || state === "backtick") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (sql[index] === "\\" && state !== "backtick") index += 1;
      else if (sql[index] === quote) {
        if (sql[index + 1] === quote) index += 1;
        else state = "normal";
      }
    } else if (state === "line-comment") {
      if (sql[index] === "\n") state = "normal";
    } else if (state === "block-comment") {
      if (sql[index] === "*" && sql[index + 1] === "/") {
        state = "normal";
        index += 1;
      }
    }
    index += 1;
  }
  push(sql.length);
  return statements;
}

export function buildSqlExecutionPayload(statements) {
  const texts = (Array.isArray(statements) ? statements : [])
    .map((item) => String(item?.text ?? item ?? "").trim())
    .filter(Boolean);
  return {
    sql: texts.join(";\n"),
    statements: texts,
  };
}

export function statementAtCursor(source, cursor = 0) {
  const sql = String(source ?? "");
  const safeCursor = Math.max(0, Math.min(sql.length, Number(cursor) || 0));
  const statements = splitSqlStatements(sql);
  return statements.find((item) => safeCursor >= item.from && safeCursor <= item.to)
    || statements.find((item) => item.from > safeCursor)
    || statements.at(-1)
    || null;
}

export function resolveSqlExecution(source, { selectionFrom = 0, selectionTo = 0, cursor = 0, all = false } = {}) {
  const sql = String(source ?? "");
  if (all) return splitSqlStatements(sql);
  const from = Math.max(0, Math.min(sql.length, Number(selectionFrom) || 0));
  const to = Math.max(from, Math.min(sql.length, Number(selectionTo) || 0));
  if (to > from) return splitSqlStatements(sql.slice(from, to)).map((item) => ({
    ...item,
    from: item.from + from,
    to: item.to + from,
  }));
  const current = statementAtCursor(sql, cursor);
  return current ? [current] : [];
}

export function maskSqlCommentsAndStrings(source) {
  const sql = String(source ?? "");
  let out = "";
  let index = 0;
  let state = "normal";
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (state === "normal") {
      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "single" : char === '"' ? "double" : "backtick";
        out += " ";
      } else if (char === "#" || (char === "-" && next === "-" && /\s|$/.test(sql[index + 2] || ""))) {
        state = "line-comment";
        out += " ";
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        out += "  ";
        index += 1;
      } else out += char;
    } else if (state === "line-comment") {
      out += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "normal";
    } else if (state === "block-comment") {
      out += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        out += " ";
        index += 1;
        state = "normal";
      }
    } else {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      out += char === "\n" ? "\n" : " ";
      if (char === "\\" && state !== "backtick" && index + 1 < sql.length) {
        out += " ";
        index += 1;
      } else if (char === quote) {
        if (next === quote) {
          out += " ";
          index += 1;
        } else state = "normal";
      }
    }
    index += 1;
  }
  return out;
}

function topLevelWordTokens(masked) {
  const tokens = [];
  let depth = 0;
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < masked.length && /[A-Za-z0-9_$]/.test(masked[index])) index += 1;
      tokens.push({ word: masked.slice(start, index).toUpperCase(), index: start });
      continue;
    }
    index += 1;
  }
  return tokens;
}

function resolveStatementOperation(masked) {
  const tokens = topLevelWordTokens(masked);
  const first = tokens[0];
  if (!first || first.word !== "WITH") return { operation: first, tokens };
  return {
    operation: tokens.slice(1).find((token) => CTE_OPERATION_KEYWORDS.has(token.word)) || first,
    tokens,
  };
}

export function classifySqlStatement(source) {
  const masked = maskSqlCommentsAndStrings(source).trim();
  const { operation, tokens } = resolveStatementOperation(masked);
  const keyword = operation?.word || "UNKNOWN";
  if (TRANSACTION_KEYWORDS.has(keyword)) return { keyword, kind: "transaction", highRisk: false, readOnly: false };
  if (READ_KEYWORDS.has(keyword)) return { keyword, kind: "read", highRisk: false, readOnly: true };
  if (HIGH_RISK_KEYWORDS.has(keyword)) return { keyword, kind: "write", highRisk: true, readOnly: false };
  if (WRITE_KEYWORDS.has(keyword)) {
    const missingWhere = (keyword === "UPDATE" || keyword === "DELETE")
      && !tokens.some((token) => token.word === "WHERE" && token.index > (operation?.index ?? -1));
    return { keyword, kind: "write", highRisk: missingWhere, readOnly: false };
  }
  return { keyword, kind: "write", highRisk: true, readOnly: false };
}

export function sqlLineAtOffset(source, offset) {
  return String(source ?? "").slice(0, Math.max(0, Number(offset) || 0)).split(/\r?\n/).length;
}

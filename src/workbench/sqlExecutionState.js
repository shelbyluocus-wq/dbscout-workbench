export function resetSqlExecution(tab, executionId = "") {
  if (!tab) return;
  tab.executionId = String(executionId || "");
  tab.resultSets = [];
  tab.messages = [];
  tab.executionPlan = null;
  tab.activeResultIndex = 0;
  tab.resultView = "results";
}

function resultForStatement(tab, statementIndex, values = {}) {
  let result = tab.resultSets.find((item) => item.statementIndex === statementIndex);
  if (!result) {
    result = {
      statementIndex,
      sql: "",
      category: "read",
      status: "running",
      columns: [],
      rows: [],
      durationMs: 0,
      rowCount: 0,
      affectedRows: 0,
      warnings: [],
      truncated: false,
      error: "",
      ...values,
    };
    tab.resultSets.push(result);
    tab.resultSets.sort((left, right) => left.statementIndex - right.statementIndex);
  }
  return result;
}

export function applySqlExecutionEvent(tab, payload = {}) {
  if (!tab || tab.kind !== "sql") return false;
  const type = String(payload.type || "");
  if (payload.executionId && tab.executionId && payload.executionId !== tab.executionId) return false;
  const statementIndex = Math.max(0, Number(payload.statementIndex) || 0);
  if (type === "execution-started") {
    tab.running = true;
    tab.jobId = String(payload.jobId || tab.jobId || "");
    tab.executionId = String(payload.executionId || tab.executionId || "");
    return true;
  }
  if (type === "statement-started") {
    resultForStatement(tab, statementIndex, {
      sql: String(payload.sql || ""),
      category: String(payload.category || "read"),
    });
    return true;
  }
  if (type === "result-meta") {
    const result = resultForStatement(tab, statementIndex);
    result.columns = Array.isArray(payload.columns) ? payload.columns : [];
    return true;
  }
  if (type === "row-batch") {
    const result = resultForStatement(tab, statementIndex);
    if (Array.isArray(payload.rows)) result.rows.push(...payload.rows);
    return true;
  }
  if (type === "statement-completed") {
    const result = resultForStatement(tab, statementIndex);
    Object.assign(result, {
      status: "completed",
      durationMs: Number(payload.durationMs) || 0,
      rowCount: Number(payload.rowCount) || result.rows.length,
      affectedRows: Number(payload.affectedRows) || 0,
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      truncated: Boolean(payload.truncated),
    });
    if (payload.plan) tab.executionPlan = payload.plan;
    tab.messages.push({
      type: "success",
      statementIndex,
      text: String(payload.message || `语句 ${statementIndex + 1} 执行完成`),
      durationMs: result.durationMs,
    });
    return true;
  }
  if (type === "statement-error") {
    const result = resultForStatement(tab, statementIndex);
    Object.assign(result, {
      status: "failed",
      durationMs: Number(payload.durationMs) || 0,
      error: String(payload.error || "SQL 执行失败"),
      errorOffset: Number(payload.errorOffset) || 0,
    });
    tab.messages.push({ type: "error", statementIndex, text: result.error });
    tab.resultView = "messages";
    tab.running = false;
    return true;
  }
  if (type === "cancelled") {
    tab.running = false;
    tab.messages.push({ type: "warning", text: String(payload.message || "查询已停止") });
    return true;
  }
  if (type === "execution-completed") {
    tab.running = false;
    tab.jobId = "";
    if (!tab.resultSets.some((result) => result.columns.length)) tab.resultView = "messages";
    return true;
  }
  if (type === "schema-changed") {
    tab.schemaChangedAt = Date.now();
    return true;
  }
  return false;
}

export function dispatchSqlExecutionEvent(workspace, payload = {}) {
  const tab = workspace?.tabs?.find((item) => item.id === payload.queryTabId);
  return applySqlExecutionEvent(tab, payload);
}

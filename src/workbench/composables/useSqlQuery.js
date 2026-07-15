import { computed, ref } from "vue";
import { format as formatSql } from "sql-formatter";

import { buildSqlExecutionPayload, classifySqlStatement, resolveSqlExecution } from "../utils/sqlStatements.js";
import { resetSqlExecution } from "../sqlExecutionState.js";
import { forgetRecentSqlFile, loadRecentSqlFiles, rememberRecentSqlFile } from "../utils/sqlRecentFiles.js";

const LIMIT_OPTIONS = Object.freeze([100, 500, 1000, 5000, 10000]);

function displayError(error) {
  return String(error?.message || error || "操作失败").replace(/^Error:\s*/i, "");
}

export function useSqlQuery({ tab, invokeWorkbench, confirm, alert, onSchemaChanged } = {}) {
  const editorRef = ref(null);
  const historyOpen = ref(false);
  const recentFiles = ref(loadRecentSqlFiles());
  const busyAction = ref("");
  const currentResult = computed(() => tab.value?.resultSets?.[tab.value.activeResultIndex] || null);

  function updateSql(sql) {
    const target = tab.value;
    if (!target) return;
    target.sql = String(sql ?? "");
    target.dirty = target.sql !== String(target.savedSql || "");
  }

  async function ensureWriteAllowed(statements) {
    const transactionStatements = statements.filter((item) => classifySqlStatement(item.text).kind === "transaction");
    if (transactionStatements.length) {
      await alert("请使用自动提交开关以及提交、回滚按钮管理事务，避免查询标签与数据库事务状态不一致。", { title: "请使用查询标签事务控制" });
      return false;
    }
    const writeStatements = statements.filter((item) => classifySqlStatement(item.text).kind === "write");
    if (!writeStatements.length) return true;
    if (tab.value.readOnly) {
      await alert("当前连接为只读连接，不能执行写入或结构变更。", { title: "写操作已拦截" });
      return false;
    }
    const risky = writeStatements.filter((item) => classifySqlStatement(item.text).highRisk);
    if (!risky.length) return true;
    return confirm({
      title: "确认高风险 SQL",
      message: `将在 ${tab.value.database || "当前数据库"} 执行 ${risky.length} 条高风险语句。`,
      items: risky.map((item) => item.text),
      note: "无 WHERE 的 UPDATE/DELETE、DDL 和无法识别的语句均按高风险处理。",
      confirmText: "仍然执行",
      cancelText: "取消",
      danger: true,
    });
  }

  async function ensureTransaction() {
    const target = tab.value;
    if (!target || target.autoCommit || target.transactionSessionId) return target?.transactionSessionId || "";
    const result = await invokeWorkbench("begin_sql_transaction", {
      request: { connectionId: target.connectionId, database: target.database, queryTabId: target.id },
    });
    target.transactionSessionId = String(result.sessionId || "");
    target.transactionState = "active";
    return target.transactionSessionId;
  }

  async function execute(context = {}) {
    const target = tab.value;
    if (!target || target.running) return;
    let statements = resolveSqlExecution(target.sql, context);
    if (context.explain) {
      statements = statements.slice(0, 1).map((item) => ({ ...item, text: /^\s*EXPLAIN\b/i.test(item.text) ? item.text : `EXPLAIN ${item.text}` }));
    }
    if (!statements.length) return;
    if (!(await ensureWriteAllowed(statements))) return;
    try {
      busyAction.value = "execute";
      const transactionSessionId = await ensureTransaction();
      resetSqlExecution(target);
      target.running = true;
      const executionPayload = buildSqlExecutionPayload(statements);
      const response = await invokeWorkbench("start_sql_execution", {
        request: {
          connectionId: target.connectionId,
          database: target.database,
          queryTabId: target.id,
          ...executionPayload,
          scope: context.all ? "all" : context.selectionTo > context.selectionFrom ? "selection" : "statement",
          rowLimit: target.limit,
          timeoutSeconds: target.timeoutSeconds,
          transactionSessionId: transactionSessionId || null,
          confirmedRisky: statements.some((item) => classifySqlStatement(item.text).highRisk),
        },
      });
      target.jobId = String(response.jobId || "");
      target.executionId = String(response.executionId || target.executionId || "");
    } catch (error) {
      target.running = false;
      target.messages.push({ type: "error", text: displayError(error) });
      target.resultView = "messages";
    } finally {
      busyAction.value = "";
    }
  }

  async function cancel() {
    const target = tab.value;
    if (!target?.jobId) return;
    busyAction.value = "cancel";
    try {
      await invokeWorkbench("cancel_sql_execution", { jobId: target.jobId });
    } finally {
      busyAction.value = "";
    }
  }

  async function finishTransaction(action) {
    const target = tab.value;
    if (!target?.transactionSessionId) return;
    busyAction.value = action;
    try {
      await invokeWorkbench(`${action}_sql_transaction`, { sessionId: target.transactionSessionId });
      target.transactionSessionId = "";
      target.transactionState = action === "commit" ? "committed" : "rolled-back";
      target.messages.push({ type: "success", text: action === "commit" ? "事务已提交" : "事务已回滚" });
      onSchemaChanged?.();
    } catch (error) {
      target.messages.push({ type: "error", text: displayError(error) });
    } finally {
      busyAction.value = "";
    }
  }

  function refreshRecentFiles() {
    recentFiles.value = loadRecentSqlFiles();
  }

  async function openFile(path = "") {
    const target = tab.value;
    if (!target || target.running) return false;
    try {
      const result = await invokeWorkbench("open_sql_file", { path: path || null });
      if (!result) return false;
      resetSqlExecution(target);
      Object.assign(target, {
        sql: String(result.content || ""),
        savedSql: String(result.content || ""),
        filePath: String(result.path || ""),
        fileName: String(result.fileName || ""),
        title: String(result.fileName || target.title),
        dirty: false,
      });
      recentFiles.value = rememberRecentSqlFile(result);
      editorRef.value?.focus();
      return true;
    } catch (error) {
      if (!displayError(error).includes("取消")) await alert(displayError(error));
      return false;
    }
  }

  async function saveFile({ saveAs = false } = {}) {
    const target = tab.value;
    if (!target) return false;
    try {
      const result = await invokeWorkbench("save_sql_file", {
        request: {
          path: saveAs ? null : target.filePath || null,
          fileName: target.fileName || `${target.title || "query"}.sql`,
          content: target.sql,
        },
      });
      target.filePath = String(result.path || target.filePath || "");
      target.fileName = String(result.fileName || target.fileName || "");
      target.title = target.fileName || target.title;
      target.savedSql = target.sql;
      target.dirty = false;
      recentFiles.value = rememberRecentSqlFile(result);
      return true;
    } catch (error) {
      if (!displayError(error).includes("取消")) await alert(displayError(error));
      return false;
    }
  }

  function removeRecentFile(file) {
    recentFiles.value = forgetRecentSqlFile(file?.path);
  }

  function formatDocument() {
    try {
      updateSql(formatSql(tab.value.sql, {
        language: "mysql",
        keywordCase: "upper",
        tabWidth: 2,
        linesBetweenQueries: 1,
      }));
    } catch (error) {
      void alert(displayError(error), { title: "SQL 格式化失败" });
    }
  }

  return {
    LIMIT_OPTIONS,
    editorRef,
    historyOpen,
    recentFiles,
    busyAction,
    currentResult,
    updateSql,
    execute,
    cancel,
    commit: () => finishTransaction("commit"),
    rollback: () => finishTransaction("rollback"),
    openFile,
    openRecentFile: (file) => openFile(file?.path),
    removeRecentFile,
    refreshRecentFiles,
    saveFile,
    formatDocument,
  };
}

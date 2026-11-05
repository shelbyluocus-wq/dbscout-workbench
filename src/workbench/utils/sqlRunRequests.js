// One-shot run requests for SQL tabs opened by external-UI actions: the
// orchestrator sets `tab.agentRunRequest`; the mounted SqlQueryWorkspace
// consumes it, executes, and resolves the promise with the real outcome.
const pending = new Map();

export function requestSqlRun(tab, { timeoutMs = 30000 } = {}) {
  const id = `sql-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tab.agentRunRequest = { id };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("SQL 执行超时"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

export function resolveSqlRun(id, result) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve({ status: "ok", rowCount: 0, error: "", ...(result || {}) });
  return true;
}

export function rejectSqlRun(id, error) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.reject(error instanceof Error ? error : new Error(String(error || "SQL 执行失败")));
  return true;
}

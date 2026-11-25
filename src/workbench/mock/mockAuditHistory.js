const keyOf = (row) => JSON.stringify([row.connectionId, row.database, row.tableName]);
const groupOf = (row) => row.operationId || `legacy:${row.ts}`;
const same = (a, b) => a == null ? b == null : b != null && String(a) === String(b);
const matches = (row, values) => Object.entries(values).every(([key, value]) => same(row[key], value));
const page = (items, offset = 0) => ({ items: items.slice(offset, offset + 50), hasMore: items.length > offset + 50 });
const scope = (logs, request) => logs.filter((row) => ["connectionId", "database", "tableName"].every((k) => !request[k] || row[k] === request[k]));
let operationSequence = 0;

/** Record one user action, independent of individual sync IDs. */
export function recordMockTableDiff(logs, context, table, before, after, source = "grid") {
  const keys = (table.columns || []).filter((c) => c.is_primary_key || c.isPrimaryKey).map((c) => c.column_name || c.columnName);
  if (!keys.length) return;
  const rowKey = (row) => JSON.stringify(keys.map((k) => row[k] == null ? null : String(row[k])));
  const oldRows = new Map(before.map((row) => [rowKey(row), row]));
  const newRows = new Map(after.map((row) => [rowKey(row), row]));
  let id = Math.max(0, ...logs.map((row) => row.id));
  const operationId = `mock-operation-${++operationSequence}`;
  const ts = new Date().toISOString();
  const entries = [];
  for (const [key, oldRow] of oldRows) {
    const newRow = newRows.get(key);
    if (newRow && matches(newRow, oldRow) && matches(oldRow, newRow)) continue;
    entries.push({ operation: newRow ? "UPDATE" : "DELETE", before: oldRow, after: newRow });
  }
  for (const [key, newRow] of newRows) if (!oldRows.has(key)) entries.push({ operation: "INSERT", after: newRow });
  for (const entry of entries) {
    id++;
    logs.unshift({ ...context, id, ts, operationId, operationSize: entries.length, operation: entry.operation,
      oldValue: entry.before ? JSON.stringify(entry.before) : null, newValue: entry.after ? JSON.stringify(entry.after) : null,
      rowIdentity: Object.fromEntries(keys.map((k) => [k, (entry.before || entry.after)[k]])), columnName: null,
      source, status: "committed", rollbackStrategy: "auto", isRollback: false, actor: "演示用户", clientId: `mock-cid-${id}` });
  }
}

function decode(row, raw) {
  if (row.columnName) return { [row.columnName]: raw };
  if (raw == null) throw new Error("历史记录缺少行数据，无法恢复");
  return JSON.parse(raw);
}
function restoreRows(rows, entries, keys) {
  const result = structuredClone(rows);
  for (const entry of entries) {
    if (!entry.rowIdentity || !Object.keys(entry.rowIdentity).length) throw new Error("历史记录缺少行标识");
    const oldValues = entry.operation === "INSERT" ? null : decode(entry, entry.oldValue);
    const newValues = entry.operation === "DELETE" ? null : decode(entry, entry.newValue);
    const identity = { ...entry.rowIdentity };
    if (newValues) for (const key of Object.keys(identity)) if (Object.hasOwn(newValues, key)) identity[key] = newValues[key];
    const indices = result.map((row, index) => matches(row, identity) ? index : -1).filter((index) => index >= 0);
    if (entry.operation === "DELETE") {
      if (indices.length) throw new Error("主键冲突，整次恢复已取消");
      result.push(oldValues);
    } else {
      if (indices.length !== 1 || !matches(result[indices[0]], newValues)) throw new Error("目标行与历史不一致，整次恢复已取消");
      if (entry.operation === "INSERT") result.splice(indices[0], 1);
      else Object.assign(result[indices[0]], oldValues);
    }
    const identities = result.map((row) => JSON.stringify(keys.map((key) => row[key] == null ? null : String(row[key]))));
    if (new Set(identities).size !== result.length) throw new Error("主键冲突，整次恢复已取消");
  }
  return result;
}
async function fingerprint(rows, entries) {
  const canonicalRows = rows.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).map(JSON.stringify).sort();
  const bytes = new TextEncoder().encode(JSON.stringify([canonicalRows, entries]));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createMockAuditHistory({ logs, getRows, getTable, onRestored = () => {} }) {
  return async function handle(command, request) {
    if (command === "preview_history_state_restore" || command === "apply_history_state_restore") {
      const ops = Array.isArray(request.operations) ? request.operations : [];
      if (!ops.length) throw new Error("没有需要还原的数据变更");
      const current = getRows(request);
      const table = getTable(request);
      const keys = (table.columns || []).filter((c) => c.is_primary_key || c.isPrimaryKey).map((c) => c.column_name || c.columnName);
      if (!keys.length) throw new Error("该表未设置主键，无法按行精准还原");
      const next = structuredClone(current);
      for (const op of ops) {
        const idxList = next
          .map((row, index) => (matches(row, op.rowIdentity || {}) ? index : -1))
          .filter((index) => index >= 0);
        if (op.kind === "insert") {
          if (idxList.length) throw new Error("目标主键行当前已存在，无法重新插入");
          next.push({ ...(op.targetValues || {}) });
        } else if (op.kind === "delete") {
          if (idxList.length !== 1 || !matches(next[idxList[0]], op.expectedCurrent || {})) {
            throw new Error("目标行当前值与历史记录不一致，无法直接还原");
          }
          next.splice(idxList[0], 1);
        } else if (op.kind === "update") {
          if (idxList.length !== 1 || !matches(next[idxList[0]], op.expectedCurrent || {})) {
            throw new Error("目标行当前值与历史记录不一致，无法直接还原");
          }
          Object.assign(next[idxList[0]], op.targetValues || {});
        } else {
          throw new Error("不支持的还原操作类型");
        }
      }
      const token = await fingerprint(current, ops);
      if (command === "preview_history_state_restore") {
        return {
          token,
          inserted: ops.filter((op) => op.kind === "insert").length,
          updated: ops.filter((op) => op.kind === "update").length,
          deleted: ops.filter((op) => op.kind === "delete").length,
          total: ops.length,
        };
      }
      if (token !== request.token) throw new Error("预览后表数据已变化，请重新预览；本次未修改数据");
      recordMockTableDiff(logs, { connectionId: request.connectionId, database: request.database, tableName: request.tableName }, table, current, next, "rollback");
      current.splice(0, current.length, ...next);
      onRestored(request);
      return request.targetLabel ? `已还原到 ${request.targetLabel}（演示数据）` : "已还原到所选历史状态（演示数据）";
    }
    const rows = scope(logs, request).sort((a, b) => b.id - a.id);
    if (command === "list_audit_tables") {
      const groups = new Map();
      for (const row of rows) {
        const key = keyOf(row), current = groups.get(key);
        if (current) { current.entryCount++; if (row.ts > current.latestTs) current.latestTs = row.ts; }
        else groups.set(key, { connectionId: row.connectionId, database: row.database, tableName: row.tableName, latestTs: row.ts, entryCount: 1 });
      }
      return page([...groups.values()].filter((row) => `${row.tableName} ${row.database}`.toLowerCase().includes((request.search || "").toLowerCase())).sort((a, b) => b.latestTs.localeCompare(a.latestTs) || keyOf(a).localeCompare(keyOf(b))), request.offset);
    }
    const groups = new Map();
    for (const row of rows) { const key = groupOf(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    if (command === "list_audit_operations") return page([...groups.values()].map((entries) => ({
      id: Math.min(...entries.map((row) => row.id)), lastId: Math.max(...entries.map((row) => row.id)), ts: entries[0].ts,
      source: entries[0].source, legacy: !entries[0].operationId, entryCount: entries.length,
      ...Object.fromEntries([["inserted", "INSERT"], ["updated", "UPDATE"], ["deleted", "DELETE"]].map(([label, op]) => [label, entries.filter((row) => row.operation === op && ["committed", "rolled_back"].includes(row.status)).length])),
      blocked: entries.some((row) => row.status !== "aborted" && (row.rollbackStrategy !== "auto" || !["committed", "rolled_back"].includes(row.status))),
    })).sort((a, b) => b.lastId - a.lastId), request.offset);
    const anchor = rows.find((row) => row.id === request.auditId);
    if (!anchor) throw new Error("记录已清理，请刷新列表");
    if (command === "list_audit_operation_details") return page(groups.get(groupOf(anchor)), request.offset);
    const boundary = Math.min(...groups.get(groupOf(anchor)).map((row) => row.id));
    const entries = rows.filter((row) => row.id >= boundary && row.status !== "aborted");
    if (!entries.length || entries.some((row) => row.rollbackStrategy !== "auto" || !["committed", "rolled_back"].includes(row.status))) throw new Error("这段历史存在不可恢复或待核对的记录");
    for (const row of entries) if (row.operationSize && groups.get(groupOf(row)).length !== row.operationSize) throw new Error("操作批次有记录缺失，不能恢复");
    const current = getRows(request), table = getTable(request);
    const keys = (table.columns || []).filter((c) => c.is_primary_key || c.isPrimaryKey).map((c) => c.column_name || c.columnName);
    if (!keys.length) throw new Error("表缺少可验证的主键，不能恢复");
    const token = await fingerprint(current, entries);
    const restored = restoreRows(current, entries, keys);
    if (command === "preview_audit_table_restore") return { token, targetTs: anchor.ts, operations: new Set(entries.map(groupOf)).size, entries: entries.length,
      inserted: entries.filter((e) => e.operation === "DELETE").length, updated: entries.filter((e) => e.operation === "UPDATE").length, deleted: entries.filter((e) => e.operation === "INSERT").length };
    if (token !== request.token) throw new Error("预览后数据或历史已变化，请重新预览；本次未修改数据");
    recordMockTableDiff(logs, { connectionId: request.connectionId, database: request.database, tableName: request.tableName }, table, current, restored, "rollback");
    current.splice(0, current.length, ...restored);
    onRestored(request);
    return "已恢复到所选操作之前（演示数据）";
  };
}

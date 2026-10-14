const DEFAULT_BATCH_SIZE = 100;
const PRIORITY_RANK = Object.freeze({
  visible: 0,
  recent: 1,
  background: 2,
});

class SchemaRequestCancelledError extends Error {
  constructor() {
    super("schema request was cancelled because its database source changed");
    this.name = "SchemaRequestCancelledError";
    this.code = "SCHEMA_REQUEST_CANCELLED";
  }
}

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function sourceKey(connectionId, database) {
  return `${normalized(connectionId)}\u001f${normalized(database)}`;
}

function requestKey(source, generation, tableName, force) {
  return `${source}\u001f${generation}\u001f${force ? 1 : 0}\u001f${normalized(tableName)}`;
}

function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.background;
}

function cancellationError() {
  return new SchemaRequestCancelledError();
}

export function isSchemaRequestCancelled(error) {
  return error?.code === "SCHEMA_REQUEST_CANCELLED";
}

export function useSchemaMetadata(invokeWorkbench, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const resolvedBatchSize = Math.max(1, Math.floor(Number(batchSize) || DEFAULT_BATCH_SIZE));
  const generations = new Map();
  const requests = new Map();
  let sequence = 0;
  let flushScheduled = false;
  let disposed = false;

  function generationFor(source) {
    return generations.get(source) || 0;
  }

  function cleanup(entry) {
    if (requests.get(entry.key) === entry) requests.delete(entry.key);
  }

  function settleCancelled(entry) {
    cleanup(entry);
    entry.state = "settled";
    entry.reject(cancellationError());
  }

  async function dispatch(entries) {
    if (!entries.length) return;
    for (const entry of entries) entry.state = "inflight";
    const first = entries[0];
    try {
      const result = await invokeWorkbench("get_table_schemas", {
        connectionId: first.connectionId,
        database: first.database,
        tableNames: entries.map((entry) => entry.tableName),
        force: first.force,
      });
      if (disposed || generationFor(first.source) !== first.generation) {
        entries.forEach(settleCancelled);
        return;
      }
      const schemas = Array.isArray(result) ? result : result?.schemas;
      const byTable = new Map(
        (Array.isArray(schemas) ? schemas : []).map((schema) => [
          normalized(schema?.table_name || schema?.tableName),
          schema,
        ]),
      );
      for (const entry of entries) {
        cleanup(entry);
        entry.state = "settled";
        const schema = byTable.get(normalized(entry.tableName));
        if (entry.replacement) entry.resolve(entry.replacement);
        else if (schema) entry.resolve(schema);
        else entry.reject(new Error(`schema response omitted requested table: ${entry.tableName}`));
      }
    } catch (error) {
      const cancelled = disposed || generationFor(first.source) !== first.generation;
      for (const entry of entries) {
        if (cancelled) settleCancelled(entry);
        else {
          cleanup(entry);
          entry.state = "settled";
          if (entry.replacement) entry.resolve(entry.replacement);
          else entry.reject(error);
        }
      }
    }
  }

  function flush() {
    flushScheduled = false;
    if (disposed) return;
    const queued = [...requests.values()].filter((entry) => entry.state === "queued");
    const groups = new Map();
    for (const entry of queued) {
      const groupKey = `${entry.source}\u001f${entry.generation}\u001f${entry.force ? 1 : 0}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(entry);
    }
    for (const entries of groups.values()) {
      entries.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      for (let index = 0; index < entries.length; index += resolvedBatchSize) {
        void dispatch(entries.slice(index, index + resolvedBatchSize));
      }
    }
  }

  function scheduleFlush() {
    if (flushScheduled || disposed) return;
    flushScheduled = true;
    queueMicrotask(flush);
  }

  function request({
    connectionId = "",
    database = "",
    tableName = "",
    force = false,
    priority = "background",
  } = {}) {
    if (disposed) return Promise.reject(cancellationError());
    const resolvedTableName = String(tableName || "").trim();
    if (!resolvedTableName) return Promise.reject(new Error("tableName is required"));
    const source = sourceKey(connectionId, database);
    const generation = generationFor(source);
    const key = requestKey(source, generation, resolvedTableName, force);
    const existing = (!force && requests.get(requestKey(source, generation, resolvedTableName, true))) || requests.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priorityRank(priority));
      return existing.promise;
    }

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = {
      key,
      source,
      generation,
      connectionId: String(connectionId || "").trim(),
      database: String(database || "").trim(),
      tableName: resolvedTableName,
      force: Boolean(force),
      priority: priorityRank(priority),
      sequence: sequence += 1,
      state: "queued",
      promise,
      resolve,
      reject,
    };
    // A forced read follows a schema edit. Readers still waiting for the old
    // batch, including new callers joining it, must receive the fresh schema.
    if (force) {
      const ordinary = requests.get(requestKey(source, generation, resolvedTableName, false));
      if (ordinary) ordinary.replacement = promise;
    }
    requests.set(key, entry);
    scheduleFlush();
    return promise;
  }

  function requestMany({ tableNames = [], ...source } = {}) {
    return Promise.all(
      [...new Set((Array.isArray(tableNames) ? tableNames : []).map((name) => String(name || "").trim()).filter(Boolean))]
        .map((tableName) => request({ ...source, tableName })),
    );
  }

  function cancelSource({ connectionId = "", database = "" } = {}) {
    const source = sourceKey(connectionId, database);
    generations.set(source, generationFor(source) + 1);
    for (const entry of [...requests.values()]) {
      if (entry.source !== source || entry.state !== "queued") continue;
      settleCancelled(entry);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of [...requests.values()]) settleCancelled(entry);
  }

  return {
    request,
    requestMany,
    cancelSource,
    dispose,
  };
}

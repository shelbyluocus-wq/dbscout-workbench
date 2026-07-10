import test from "node:test";
import assert from "node:assert/strict";

const module = await import("./composables/useSchemaMetadata.js").catch(() => ({}));

function requireApi(name) {
  assert.equal(typeof module[name], "function", `useSchemaMetadata must export ${name}`);
  return module[name];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushBatch() {
  await Promise.resolve();
  await Promise.resolve();
}

test("coalesces concurrent requests for one table", async () => {
  const useSchemaMetadata = requireApi("useSchemaMetadata");
  const pending = deferred();
  const calls = [];
  const metadata = useSchemaMetadata(async (command, payload) => {
    calls.push({ command, payload });
    return pending.promise;
  });
  const source = { connectionId: "mysql-1", database: "game", tableName: "hero" };

  const first = metadata.request(source);
  const second = metadata.request(source);
  await flushBatch();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "get_table_schemas");
  assert.deepEqual(calls[0].payload, {
    connectionId: "mysql-1",
    database: "game",
    tableNames: ["hero"],
    force: false,
  });
  pending.resolve([{ table_name: "hero", columns: [{ column_name: "id" }] }]);
  const [firstSchema, secondSchema] = await Promise.all([first, second]);
  assert.strictEqual(firstSchema, secondSchema);
});

test("batches adjacent tables and orders visible and recent requests first", async () => {
  const useSchemaMetadata = requireApi("useSchemaMetadata");
  const calls = [];
  const metadata = useSchemaMetadata(async (command, payload) => {
    calls.push({ command, payload });
    return payload.tableNames.map((tableName) => ({ table_name: tableName, columns: [] }));
  });

  const background = metadata.request({
    connectionId: "mysql-1",
    database: "game",
    tableName: "logs",
    priority: "background",
  });
  const recent = metadata.request({
    connectionId: "mysql-1",
    database: "game",
    tableName: "item",
    priority: "recent",
  });
  const visible = metadata.request({
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    priority: "visible",
  });
  await Promise.all([background, recent, visible]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload.tableNames, ["hero", "item", "logs"]);
});

test("loads eighty table schemas with one backend batch", async () => {
  const useSchemaMetadata = requireApi("useSchemaMetadata");
  const calls = [];
  const metadata = useSchemaMetadata(async (command, payload) => {
    calls.push({ command, payload });
    return payload.tableNames.map((tableName) => ({
      table_name: tableName,
      columns: [{ column_name: "id" }],
    }));
  });
  const tableNames = Array.from({ length: 80 }, (_, index) => `table_${index + 1}`);

  const schemas = await metadata.requestMany({
    connectionId: "mysql-1",
    database: "game",
    tableNames,
    priority: "background",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.tableNames.length, 80);
  assert.deepEqual(schemas.map((schema) => schema.table_name), tableNames);
});

test("cancelling a source rejects its late result and a new generation loads independently", async () => {
  const useSchemaMetadata = requireApi("useSchemaMetadata");
  const isSchemaRequestCancelled = requireApi("isSchemaRequestCancelled");
  const calls = [];
  const pending = [];
  const metadata = useSchemaMetadata(async (command, payload) => {
    calls.push({ command, payload });
    const request = deferred();
    pending.push(request);
    return request.promise;
  });
  const source = { connectionId: "mysql-1", database: "game", tableName: "hero" };

  const stale = metadata.request(source);
  await flushBatch();
  metadata.cancelSource(source);
  const fresh = metadata.request(source);
  await flushBatch();
  assert.equal(calls.length, 2);

  pending[0].resolve([{ table_name: "hero", table_comment: "stale", columns: [] }]);
  await assert.rejects(stale, isSchemaRequestCancelled);
  pending[1].resolve([{ table_name: "hero", table_comment: "fresh", columns: [] }]);
  assert.equal((await fresh).table_comment, "fresh");
});

test("missing or failed schemas are retryable instead of being cached", async () => {
  const useSchemaMetadata = requireApi("useSchemaMetadata");
  let call = 0;
  const metadata = useSchemaMetadata(async () => {
    call += 1;
    if (call === 1) throw new Error("schema unavailable");
    return [{ table_name: "hero", columns: [] }];
  });
  const source = { connectionId: "mysql-1", database: "game", tableName: "hero" };

  await assert.rejects(metadata.request(source), /schema unavailable/);
  assert.equal((await metadata.request(source)).table_name, "hero");
  assert.equal(call, 2);
});

test("force requests do not upgrade unrelated queued reads", async () => {
  const useSchemaMetadata = requireApi("useSchemaMetadata");
  const calls = [];
  const metadata = useSchemaMetadata(async (command, payload) => {
    calls.push({ command, payload });
    return payload.tableNames.map((tableName) => ({ table_name: tableName, columns: [] }));
  });

  await Promise.all([
    metadata.request({ connectionId: "mysql-1", database: "game", tableName: "hero" }),
    metadata.request({ connectionId: "mysql-1", database: "game", tableName: "item", force: true }),
  ]);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.payload.force).sort(), [false, true]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import { useTableFolders } from "./composables/useTableFolders.js";

test("folder list verifies schema ownership instead of trusting a pending sidebar selection", async () => {
  const scope = { connectionId: "mysql", database: "original" };
  const workspace = {
    ...scope,
    schema: [{ connectionId: "mysql", database: "other", table_name: "other_table" }],
  };
  const calls = [];
  const folders = useTableFolders({
    workspace,
    selectedConnectionId: ref("mysql"),
    selectedDatabase: ref("original"),
    invokeWorkbench: async (command, args) => {
      calls.push({ command, args });
      return [{ table_name: "goodsprop" }];
    },
  });
  assert.deepEqual(await folders.context.loadTables(scope), [{ name: "goodsprop", comment: "" }]);
  assert.deepEqual(calls, [{ command: "list_tables", args: { ...scope, priority: "visible" } }]);
  workspace.schema = [{ ...scope, table_name: "goodsprop" }];
  assert.deepEqual(await folders.context.loadTables(scope), [{ name: "goodsprop", comment: "" }]);
  assert.equal(calls.length, 1);
  workspace.database = "other";
  await folders.context.loadTables(scope);
  assert.equal(calls.length, 2);
  workspace.schema = [];
  await folders.context.loadTables(scope);
  assert.equal(calls.length, 3);
});

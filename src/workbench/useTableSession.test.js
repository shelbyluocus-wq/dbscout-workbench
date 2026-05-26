import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { useTableSession } from "./composables/useTableSession.js";
import { createWorkspaceState } from "./workspaceState.js";

test("opening a table binds the tab and backend session to its connection and database", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-stage", database: "stage_game" });
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") {
      return { table_name: "hero", table_comment: "英雄配置", columns: [] };
    }
    return {
      sessionId: "stage-hero-session",
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 1000,
    };
  };
  const session = useTableSession(workspace, invoke, {
    busy: ref(false),
    statusText: ref(""),
  });

  await session.openTable({ table_name: "hero" });

  assert.deepEqual(calls[0], {
    command: "get_table_schema",
    payload: { connectionId: "mysql-stage", database: "stage_game", tableName: "hero" },
  });
  assert.deepEqual(calls[1], {
    command: "open_table_session",
    payload: {
      connectionId: "mysql-stage",
      database: "stage_game",
      tableName: "hero",
      options: { page: 1, pageSize: 1000 },
    },
  });
  assert.equal(workspace.tabs[0].connectionId, "mysql-stage");
  assert.equal(workspace.tabs[0].database, "stage_game");
});

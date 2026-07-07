import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReplayMessages } from "./replayMessages.mjs";

describe("replay messages", () => {
  it("restores project context and labels from turn context snapshots", () => {
    const context = {
      connectionId: "demo",
      connectionLabel: "demo",
      database: "game_db",
      activeTableName: "player",
      project: {
        id: "project-1",
        name: "dbscout-workbench",
        rootPath: "E:/project/dbscout-workbench",
        shortPath: "E:/project/dbscout-workbench",
        readOnly: true,
        available: true,
      },
    };
    const messages = buildReplayMessages([
      {
        type: "user",
        uuid: "u1",
        message: {
          content: `DB Scout 当前上下文:\n当前连接: demo\n当前数据库: game_db\n当前活动表: player\n当前项目: dbscout-workbench (只读)\n项目路径: E:/project/dbscout-workbench\nDBSCOUT_CONTEXT_JSON: ${JSON.stringify(context)}\n\n用户问题:\n这个项目入口在哪里？`,
        },
      },
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "这个项目入口在哪里？");
    assert.equal(messages[0].contextLabel, "game_db.player");
    assert.equal(messages[0].projectLabel, "项目：dbscout-workbench");
    assert.equal(messages[0].context.project.rootPath, "E:/project/dbscout-workbench");
  });

  it("preserves raw tool result content so replayed evidence remains clickable", () => {
    const messages = buildReplayMessages([
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "get_database_profile",
              input: { database: "game_db" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    references: [
                      {
                        kind: "cell",
                        tableName: "player",
                        columnName: "username",
                        rowIdentity: { id: "1" },
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        },
      },
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].toolResults.length, 1);
    assert.deepEqual(messages[0].toolResults[0].result, [
      {
        type: "text",
        text: JSON.stringify({
          references: [
            {
              kind: "cell",
              tableName: "player",
              columnName: "username",
              rowIdentity: { id: "1" },
            },
          ],
        }),
      },
    ]);
  });
});

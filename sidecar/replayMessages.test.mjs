import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReplayMessages } from "./replayMessages.mjs";

describe("replay messages", () => {
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

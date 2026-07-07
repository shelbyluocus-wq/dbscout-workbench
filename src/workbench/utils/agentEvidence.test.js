import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEvidenceReferences } from "./agentEvidence.js";

describe("agentEvidence", () => {
  it("extracts clickable cell references from tool result references", () => {
    const refs = extractEvidenceReferences([
      {
        result: {
          references: [
            {
              kind: "cell",
              database: "game_db",
              tableName: "player",
              columnName: "name",
              rowIdentity: { id: "1" },
              rowKey: "id=1",
            },
          ],
        },
      },
    ]);

    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0].action, {
      action: "focus_cell",
      database: "game_db",
      tableName: "player",
      tableComment: "",
      columnName: "name",
      rowKey: "id=1",
      rowIdentity: { id: "1" },
    });
    assert.equal(refs[0].label, "player.name #id=1");
  });

  it("extracts column references nested under search results", () => {
    const refs = extractEvidenceReferences([
      {
        result: {
          results: [
            {
              label: "player.level",
              reference: {
                kind: "column",
                tableName: "player",
                columnName: "level",
              },
            },
          ],
        },
      },
    ]);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].action.action, "focus_column");
    assert.equal(refs[0].action.tableName, "player");
    assert.equal(refs[0].action.columnName, "level");
    assert.equal(refs[0].label, "player.level");
  });

  it("parses JSON text blocks from SDK tool results", () => {
    const refs = extractEvidenceReferences([
      {
        result: [
          {
            type: "text",
            text: JSON.stringify({
              reference: {
                kind: "row",
                tableName: "orders",
                rowIdentity: { order_id: "A100" },
              },
            }),
          },
        ],
      },
    ]);

    assert.equal(refs.length, 1);
    assert.equal(refs[0].action.action, "focus_row");
    assert.equal(refs[0].label, "orders #order_id=A100");
  });
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  TABLE_DESIGN_CLIPBOARD_KIND,
  serializeTableDesignColumns,
  parseTableDesignColumns,
  uniqueColumnName,
  columnsForPaste,
  setTableDesignClipboard,
  resolveTableDesignClipboard,
  peekTableDesignClipboard,
  clearTableDesignClipboard,
  hasEditableTextSelection,
} from "./utils/tableDesignClipboard.js";

function sampleColumn(overrides = {}) {
  return {
    id: "col-1",
    originalName: "id",
    name: "id",
    type: "bigint",
    length: "",
    scale: "",
    originalType: "bigint",
    nullable: false,
    primaryKey: true,
    primaryKeyOrdinal: 1,
    defaultMode: "none",
    defaultValue: "",
    comment: "主键",
    ...overrides,
  };
}

test("serializeTableDesignColumns writes a parseable field payload without identity", () => {
  const text = serializeTableDesignColumns([sampleColumn()]);
  const parsed = parseTableDesignColumns(text);

  assert.equal(parsed.kind, TABLE_DESIGN_CLIPBOARD_KIND);
  assert.equal(parsed.columns.length, 1);
  assert.equal(parsed.columns[0].name, "id");
  assert.equal(parsed.columns[0].type, "bigint");
  assert.equal(parsed.columns[0].nullable, false);
  assert.equal(parsed.columns[0].comment, "主键");
  assert.equal(Object.hasOwn(parsed.columns[0], "id"), false);
  assert.equal(Object.hasOwn(parsed.columns[0], "originalName"), false);
  assert.equal(Object.hasOwn(parsed.columns[0], "primaryKey"), false);
});

test("parseTableDesignColumns rejects ordinary text and grid TSV", () => {
  assert.equal(parseTableDesignColumns("hello"), null);
  assert.equal(parseTableDesignColumns("id\tname\n1\tAlice"), null);
  assert.equal(parseTableDesignColumns(""), null);
  assert.equal(parseTableDesignColumns(null), null);
  assert.equal(parseTableDesignColumns(JSON.stringify({ kind: "other", columns: [{}] })), null);
  assert.equal(parseTableDesignColumns(JSON.stringify({ kind: TABLE_DESIGN_CLIPBOARD_KIND, columns: [] })), null);
});

test("uniqueColumnName keeps unused names and suffixes collisions", () => {
  assert.equal(uniqueColumnName("gold", []), "gold");
  assert.equal(uniqueColumnName("gold", ["gold"]), "gold_copy");
  assert.equal(uniqueColumnName("gold", ["gold", "gold_copy"]), "gold_copy2");
  assert.equal(uniqueColumnName("Gold", ["gold"]), "Gold_copy");
  assert.equal(uniqueColumnName("  ", ["id"]), "  ");
});

test("columnsForPaste inserts new fields and strips identity plus primary key", () => {
  const pasted = columnsForPaste(
    [
      sampleColumn(),
      sampleColumn({
        name: "name",
        type: "varchar",
        length: "64",
        nullable: true,
        primaryKey: false,
        defaultMode: "value",
        defaultValue: "",
        comment: "名称",
      }),
    ],
    [{ name: "id" }],
  );

  assert.equal(pasted.length, 2);
  assert.equal(pasted[0].name, "id_copy");
  assert.equal(pasted[0].originalName, "");
  assert.equal(pasted[0].primaryKey, false);
  assert.equal(pasted[0].primaryKeyOrdinal, null);
  assert.ok(pasted[0].id);
  assert.notEqual(pasted[0].id, "col-1");
  assert.equal(pasted[1].name, "name");
  assert.equal(pasted[1].type, "varchar");
  assert.equal(pasted[1].length, "64");
  assert.equal(pasted[1].nullable, true);
  assert.equal(pasted[1].defaultMode, "value");
  assert.equal(pasted[1].comment, "名称");
  assert.equal(pasted[1].originalName, "");
});

test("columnsForPaste unique-names repeated copies against already-taken names", () => {
  const first = columnsForPaste([sampleColumn({ name: "gold" })], [{ name: "gold" }]);
  const second = columnsForPaste(
    [sampleColumn({ name: "gold" })],
    [{ name: "gold" }, { name: first[0].name }],
  );

  assert.equal(first[0].name, "gold_copy");
  assert.equal(second[0].name, "gold_copy2");
});

test("resolveTableDesignClipboard prefers OS text and can fall back to the internal payload", () => {
  clearTableDesignClipboard();
  const text = serializeTableDesignColumns([sampleColumn({ name: "score" })]);
  setTableDesignClipboard(text);

  assert.equal(peekTableDesignClipboard()?.columns[0].name, "score");
  assert.equal(resolveTableDesignClipboard(text).columns[0].name, "score");
  assert.equal(resolveTableDesignClipboard("not-fields"), null);
  assert.equal(resolveTableDesignClipboard("", { allowInternalFallback: true }).columns[0].name, "score");
  assert.equal(resolveTableDesignClipboard(""), null);

  clearTableDesignClipboard();
  assert.equal(peekTableDesignClipboard(), null);
});

test("hasEditableTextSelection is true only when an input has a real range", () => {
  assert.equal(hasEditableTextSelection(null), false);
  assert.equal(hasEditableTextSelection({ tagName: "DIV" }), false);
  assert.equal(hasEditableTextSelection({
    closest: () => ({ selectionStart: 0, selectionEnd: 0 }),
  }), false);
  assert.equal(hasEditableTextSelection({
    closest: () => ({ selectionStart: 1, selectionEnd: 4 }),
  }), true);
});

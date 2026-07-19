import test from "node:test";
import assert from "node:assert/strict";

import { parseGridTsv, serializeGridTsv } from "./gridClipboardTsv.js";

test("empty clipboard text has no paste cells", () => {
  assert.deepEqual(parseGridTsv(""), []);
  assert.deepEqual(parseGridTsv("\r\n"), []);
});

test("TSV quoting preserves tabs newlines and quotes across external apps", () => {
  const matrix = [
    ["alpha\tbeta", "first line\nsecond line", "say \"hello\""],
    ["", "plain", "中文"],
  ];

  const text = serializeGridTsv(matrix);

  assert.equal(text, '"alpha\tbeta"\t"first line\nsecond line"\t"say ""hello"""\n\tplain\t中文');
  assert.deepEqual(parseGridTsv(text), matrix);
});

test("quoted TSV from Excel can contain CRLF inside one cell", () => {
  assert.deepEqual(
    parseGridTsv('"line 1\r\nline 2"\tvalue\r\nnext\trow\r\n'),
    [["line 1\nline 2", "value"], ["next", "row"]],
  );
});

test("a rectangular row of empty cells remains a real paste matrix", () => {
  assert.deepEqual(parseGridTsv("\t"), [["", ""]]);
});

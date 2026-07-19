import test from "node:test";
import assert from "node:assert/strict";

import { buildRowIdentity, buildRowKey } from "./utils/rowIdentity.js";

function table() {
  return {
    columns: [{ column_name: "a" }, { column_name: "b" }],
    primaryKeys: [],
  };
}

test("fallback row identity keeps SQL NULL distinct from an empty string", () => {
  assert.deepEqual(buildRowIdentity(table(), { a: null, b: "" }), { a: null, b: "" });
  assert.notEqual(
    buildRowKey(table(), { a: null, b: "" }),
    buildRowKey(table(), { a: "", b: "" }),
  );
});

test("row keys cannot collide when values contain separators", () => {
  const first = buildRowKey(table(), { a: "x&b=y", b: "" });
  const second = buildRowKey(table(), { a: "x", b: "y&b=" });

  assert.notEqual(first, second);
});

test("row keys are deterministic regardless of object insertion order", () => {
  assert.equal(
    buildRowKey(table(), { a: "one", b: "two" }),
    buildRowKey(table(), { b: "two", a: "one" }),
  );
});

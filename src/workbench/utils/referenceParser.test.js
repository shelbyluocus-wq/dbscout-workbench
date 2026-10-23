import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeReferenceParser, parseReferenceValues } from "./referenceParser.js";
import { normalizeRelationFilter, relationFilterKey } from "./relationFilter.js";
import { referenceValuesFromCell } from "./configRelations.js";
import { relationRowMatches } from "../mock/mockConfigRelations.js";
import { incomingRelationFilter } from "../incomingRelationRows.js";

const fixtures = JSON.parse(readFileSync(new URL("../../../tests/fixtures/config-reference-formats.json", import.meta.url)));
for (const fixture of fixtures) {
  test(fixture.name, () => {
    assert.deepEqual(parseReferenceValues(fixture.text, fixture.parser), fixture.values);
    assert.deepEqual(referenceValuesFromCell("value", fixture.text, fixture.parser), fixture.values || []);
    const relation = { sourceColumn: "Config", kind: "value", parser: fixture.parser };
    const columns = [{ column_name: "Config" }];
    for (const value of fixture.values || []) {
      const filter = normalizeRelationFilter(incomingRelationFilter(relation, value));
      assert.deepEqual(filter.parser, fixture.parser);
      assert.equal(relationRowMatches({ Config: fixture.text }, columns, filter), true);
    }
    assert.equal(relationRowMatches({ Config: fixture.text }, columns,
      incomingRelationFilter(relation, "definitely_absent")), false);
  });
}

test("tab identity preserves parser, selector and condition routing", () => {
  const base = { column: "Enc", kind: "listContains", values: ["81"] };
  const gift = { type: "json", member: "Num", selector: { member: "ID", value: "0" } };
  const purchase = { ...gift, selector: { member: "ID", value: "999" } };
  assert.notEqual(relationFilterKey({ ...base, parser: gift }), relationFilterKey({ ...base, parser: purchase }));
  assert.deepEqual(normalizeRelationFilter({ ...base, parser: { type: "futureFormat" } }).parser, { type: "unsupported" });
});

test("malformed persisted parser constraints stay unchecked instead of widening matches", () => {
  for (const ranges of ["1001-1999", [null], [7], [[1]], [[9, 1]], [[1, Infinity]], [[-1, 8]], [["1", "9"]]]) {
    const parser = { type: "json", member: "ID", ranges };
    assert.deepEqual(normalizeReferenceParser(parser), { type: "unsupported" });
    assert.equal(parseReferenceValues('[{"ID":7}]', parser), null);
  }
  assert.deepEqual(normalizeReferenceParser({ type: "json", member: "Num", selector: {} }), { type: "unsupported" });
});

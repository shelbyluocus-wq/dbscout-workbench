import test from "node:test";
import assert from "node:assert/strict";
import { matchesRelationConstraints } from "./relationConstraints.js";
import { normalizeRelationFilter, relationFilterKey } from "./relationFilter.js";
import { incomingRelationFilter } from "../incomingRelationRows.js";
import { relationRowMatches } from "../mock/mockConfigRelations.js";
import { relationRelevantColumns } from "./configRelations.js";

const sourceConstraints = [{ column: "Kind", values: ["3"] }, { column: "CondTypeID", values: ["20215"] }];
const relation = { sourceColumn: "Param1", targetColumn: "ModelID", kind: "value", sourceConstraints };

test("activity parameters match their type, not just the shared model number", () => {
  const columns = ["Kind", "CondTypeID", "Param1"].map((columnName) => ({ columnName }));
  const filter = normalizeRelationFilter(incomingRelationFilter(relation, "11"));
  assert.deepEqual(filter.sourceConstraints, sourceConstraints);
  assert.equal(relationRowMatches({ Kind: "3", CondTypeID: "20215", Param1: "11" }, columns, filter), true);
  assert.equal(relationRowMatches({ Kind: "3", CondTypeID: "20217", Param1: "11" }, columns, filter), false);
  assert.equal(relationRowMatches({ Kind: "1", CondTypeID: "20215", Param1: "11" }, columns, filter), false);
  assert.equal(matchesRelationConstraints({ kind: "3", condtypeid: "20215" }, sourceConstraints), true);
  assert.equal(matchesRelationConstraints({}, sourceConstraints), false);
  assert.equal(matchesRelationConstraints({ Kind: "3" }, [{ column: "Kind", values: [] }]), false);
  assert.notEqual(relationFilterKey(filter), relationFilterKey({ ...filter, sourceConstraints: [{ column: "Kind", values: ["1"] }] }));
  assert.ok(relationRelevantColumns([relation]).includes("condtypeid"));
});

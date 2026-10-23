// Verify Rust-generated reference parsers against the same exported rows in
// JavaScript, including inverse filtering. This never connects to a database.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { referenceValuesFromCell } from "../src/workbench/utils/configRelations.js";
import { parseReferenceValues } from "../src/workbench/utils/referenceParser.js";
import { normalizeRelationFilter } from "../src/workbench/utils/relationFilter.js";
import { incomingRelationFilter } from "../src/workbench/incomingRelationRows.js";
import { relationRowMatches } from "../src/workbench/mock/mockConfigRelations.js";
import { matchesRelationConstraints } from "../src/workbench/utils/relationConstraints.js";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the exported audit directory");
const read = async (file) => JSON.parse(await readFile(join(directory, file), "utf8"));
const audit = await read("relations-audit.json");
const tables = new Map();
const tableFor = async (name) => {
  if (!tables.has(name)) tables.set(name, await read(`${name}.json`));
  return tables.get(name);
};
let parsedCells = 0;
let unparsedCells = 0;
for (const entry of audit.relations) {
  const view = entry.relation;
  const { rows } = await tableFor(view.sourceTable);
  const target = await tableFor(view.targetTable);
  const keys = new Set(target.rows.map((row) => String(row[view.targetColumn] ?? "").trim().toLowerCase()));
  let populated = 0;
  let unparsed = 0;
  const missing = {};
  assert.equal(entry.parsedValues.length, rows.length, `${view.id}: checked row count`);
  for (const [index, row] of rows.entries()) {
    const text = row[view.sourceColumn];
    const applies = matchesRelationConstraints(row, view.sourceConstraints);
    const parsed = !applies ? [] : view.parser ? parseReferenceValues(text, view.parser) : referenceValuesFromCell(view.kind, text);
    assert.deepEqual(parsed, entry.parsedValues[index], `${view.id}: row ${index + 1}`);
    const values = parsed || [];
    if (parsed === null) unparsed++;
    if (values.length) populated++;
    for (const value of values) if (!keys.has(value.toLowerCase())) missing[value] = (missing[value] || 0) + 1;
  }
  assert.equal(populated, entry.populated, `${view.id}: populated`);
  assert.equal(unparsed, entry.unparsed, `${view.id}: unparsed`);
  assert.deepEqual(missing, entry.missing, `${view.id}: missing`);
  parsedCells += rows.length;
  unparsedCells += unparsed;
  assert.equal(entry.sampleAgrees, true, `${view.id}: background sample drift`);
}
for (const check of audit.sqlChecks) {
  const view = audit.relations.find((entry) => entry.relation.id === check.relation).relation;
  const { rows, schema } = await tableFor(check.table);
  const filter = normalizeRelationFilter(incomingRelationFilter(view, check.value));
  const count = rows.filter((row) => relationRowMatches(row, schema.columns, filter)).length;
  assert.equal(count, check.expected, `${view.id}: inverse ${check.value}`);
}
const result = { tables: audit.tables, relations: audit.relations.length, parsedCells, unparsedCells, inverseChecks: audit.sqlChecks.length };
await writeFile(join(directory, "frontend-verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

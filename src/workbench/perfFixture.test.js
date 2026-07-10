import test from "node:test";
import assert from "node:assert/strict";

const fixture = await import("./mock/perfFixture.js").catch(() => ({}));

function requireApi(name) {
  assert.equal(typeof fixture[name], "function", `perfFixture must export ${name}`);
  return fixture[name];
}

test("performance fixture accepts only the exact profile and named scenarios", () => {
  const parse = requireApi("parsePerfFixtureLocation");

  assert.deepEqual(
    parse("?perfProfile=deterministic-v1&scenario=rows-100k-500-pk"),
    { profile: "deterministic-v1", scenario: "rows-100k-500-pk" },
  );
  assert.equal(parse("?perfProfile=deterministic-v1&scenario=unknown"), null);
  assert.equal(parse("?perfProfile=deterministic-v1&scenario=rows-100k-500-pk&rows=9"), null);
  assert.equal(parse("?perfProfile=other&scenario=rows-100k-500-pk"), null);
  assert.equal(parse(""), null);
});

test("fixture scenarios cover every required deterministic shape", () => {
  const list = requireApi("listPerfFixtureScenarios");
  const scenarios = list();
  const tableScenarios = scenarios.filter((scenario) => scenario.kind === "table");

  for (const rowCount of [1_000, 10_000, 50_000, 100_000]) {
    assert.ok(tableScenarios.some((scenario) => scenario.rowCount === rowCount), `missing ${rowCount} rows`);
  }
  for (const columnCount of [12, 40, 60, 200, 500]) {
    assert.ok(scenarios.some((scenario) => scenario.columnCount === columnCount), `missing ${columnCount} columns`);
  }
  assert.ok(tableScenarios.some((scenario) => scenario.primaryKey === true));
  assert.ok(tableScenarios.some((scenario) => scenario.primaryKey === false));
  assert.ok(scenarios.some((scenario) => scenario.kind === "insert" && scenario.rowCount === 100 && scenario.columnCount === 20));
  assert.ok(scenarios.some((scenario) => scenario.kind === "insert" && scenario.rowCount === 500 && scenario.columnCount === 20));
  assert.deepEqual(
    scenarios.find((scenario) => scenario.name === "import-10k"),
    { name: "import-10k", kind: "insert", rowCount: 10_000, columnCount: 20, primaryKey: true },
  );
  assert.ok(scenarios.some((scenario) => scenario.kind === "schema" && scenario.tableCount === 800 && scenario.columnCount === 60));
});

test("large fixture pages generate only the requested range and stable sentinel values", () => {
  const pageFor = requireApi("createPerfFixturePage");

  const first = pageFor("rows-100k-500-pk", { offset: 0, limit: 3 });
  const second = pageFor("rows-100k-500-pk", { offset: 0, limit: 3 });
  assert.equal(first.totalRows, 100_000);
  assert.equal(first.columns.length, 500);
  assert.equal(first.rows.length, 3);
  assert.equal(first.generatedRows, 3);
  assert.deepEqual(first, second);
  assert.equal(first.rows[0].id, "1");
  assert.equal(first.rows[0].field_001, "rows-100k-500-pk|r000001|c001");

  const tail = pageFor("rows-100k-500-pk", { offset: 99_999, limit: 100 });
  assert.equal(tail.rows.length, 1);
  assert.equal(tail.generatedRows, 1);
  assert.equal(tail.rows[0].id, "100000");
});

test("no-primary-key fixtures expose no primary key while schema fixtures are exact", () => {
  const pageFor = requireApi("createPerfFixturePage");
  const schemaFor = requireApi("createPerfFixtureSchema");

  const page = pageFor("rows-100k-40-no-pk", { offset: 0, limit: 2 });
  assert.deepEqual(page.primaryKeys, []);
  assert.equal(page.rows[0].field_000, "rows-100k-40-no-pk|r000001|c000");

  const schema = schemaFor("schema-800x60");
  assert.equal(schema.tables.length, 800);
  assert.equal(schema.generatedTables, 800);
  assert.equal(schema.generatedColumns, 48_000);
  assert.ok(schema.tables.every((table) => table.columns.length === 60));
  assert.equal(schema.tables[799].table_name, "perf_schema_table_0800");
});

test("fixture hash is stable and derived from canonical profile bytes", async () => {
  const canonical = requireApi("canonicalPerfFixtureText");
  const hash = requireApi("perfFixtureHash");

  assert.equal(canonical(), canonical());
  assert.match(await hash(), /^[a-f0-9]{64}$/);
  assert.equal(await hash(), await hash());
});

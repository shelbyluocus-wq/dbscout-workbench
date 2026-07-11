import test from "node:test";
import assert from "node:assert/strict";

const benchmarkModule = await import("./workbench-benchmarks.mjs").catch(() => ({}));

function requireApi(name) {
  assert.equal(
    typeof benchmarkModule[name],
    "function",
    `workbench-benchmarks.mjs must export ${name}`,
  );
  return benchmarkModule[name];
}

test("measured cases reset before every warmup and sample while retaining raw durations", async () => {
  const runMeasuredCase = requireApi("runMeasuredCase");
  const events = [];
  const ticks = [0, 2, 10, 13, 20, 24];
  const result = await runMeasuredCase({
    name: "example",
    warmupCount: 1,
    sampleCount: 2,
    reset: async ({ phase, index }) => events.push(["reset", phase, index]),
    operation: async ({ phase, index }) => events.push(["operation", phase, index]),
    now: () => ticks.shift(),
  });

  assert.deepEqual(events, [
    ["reset", "warmup", 0],
    ["operation", "warmup", 0],
    ["reset", "sample", 0],
    ["operation", "sample", 0],
    ["reset", "sample", 1],
    ["operation", "sample", 1],
  ]);
  assert.deepEqual(result.rawSamples, [3, 4]);
  assert.equal(result.summary.p50, 3.5);
});

test("pair scheduler is deterministic, balanced, and interleaves both builds", () => {
  const createInterleavedSchedule = requireApi("createInterleavedSchedule");
  const first = createInterleavedSchedule({ rounds: 6, seed: "fixture-v1" });
  const second = createInterleavedSchedule({ rounds: 6, seed: "fixture-v1" });

  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  for (let index = 0; index < first.length; index += 2) {
    assert.deepEqual(new Set(first.slice(index, index + 2)), new Set(["baseline", "candidate"]));
  }
  assert.equal(first.filter((entry) => entry === "baseline").length, 6);
  assert.equal(first.filter((entry) => entry === "candidate").length, 6);
});

test("benchmark catalog covers every declared Task 4 product hotspot", () => {
  const benchmarkCaseDefinitions = requireApi("benchmarkCaseDefinitions");
  const definitions = benchmarkCaseDefinitions();

  assert.deepEqual(definitions.map((entry) => entry.name), [
    "visual-index-lookup",
    "arrow-navigation",
    "row-range-selection",
    "insert-draft-update-and-paste",
    "import-validation",
    "page-append",
    "schema-search",
    "agent-delta-aggregation",
  ]);
  for (const definition of definitions.filter((entry) => entry.class === "interaction")) {
    assert.equal(definition.warmupCount, 5);
    assert.ok(definition.sampleCount >= 100);
  }
});

test("benchmark cases execute the real product modules instead of substitute algorithms", async () => {
  const createBenchmarkCases = requireApi("createBenchmarkCases");
  const cases = await createBenchmarkCases({ rowCount: 1_000 });

  assert.equal(cases.length, 8);
  for (const benchmark of cases) {
    assert.equal(typeof benchmark.reset, "function", `${benchmark.name} reset`);
    assert.equal(typeof benchmark.operation, "function", `${benchmark.name} operation`);
    assert.match(benchmark.sourceModule, /^src\/workbench\//u);
  }
  const visual = cases.find((entry) => entry.name === "visual-index-lookup");
  await visual.reset({ phase: "sample", index: 0 });
  await visual.operation({ phase: "sample", index: 0 });
  assert.equal(visual.readSink(), 999);

  const insertPaste = cases.find((entry) => entry.name === "insert-draft-update-and-paste");
  await insertPaste.reset({ phase: "sample", index: 0 });
  await insertPaste.operation({ phase: "sample", index: 0 });
  assert.equal(insertPaste.readSink(), 10_000);

  const importValidation = cases.find((entry) => entry.name === "import-validation");
  await importValidation.reset({ phase: "sample", index: 0 });
  await importValidation.operation({ phase: "sample", index: 0 });
  assert.equal(importValidation.readSink(), 10_000);
});

test("benchmark case selection is explicit and rejects unknown case names", () => {
  const selectBenchmarkCases = requireApi("selectBenchmarkCases");
  const cases = [
    { name: "arrow-navigation" },
    { name: "page-append" },
  ];

  assert.deepEqual(selectBenchmarkCases(cases, ["arrow-navigation"]), [cases[0]]);
  assert.deepEqual(selectBenchmarkCases(cases, []), cases);
  assert.throws(
    () => selectBenchmarkCases(cases, ["missing-case"]),
    /Unknown benchmark case: missing-case/u,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const uiModule = await import("./ui-suite.mjs").catch(() => ({}));

function requireApi(name) {
  assert.equal(typeof uiModule[name], "function", `ui-suite.mjs must export ${name}`);
  return uiModule[name];
}

function harness(overrides = {}) {
  const events = [];
  const child = { pid: 9876, exitCode: null };
  const browser = { close: async () => events.push("browser.close") };
  return {
    events,
    child,
    options: {
      rootDirectory: "C:\\repo",
      scenario: "smoke",
      samples: 5,
      findPort: async () => 15431,
      spawnProcess: (command, args, options) => {
        events.push(["spawn", command, args, options]);
        return child;
      },
      waitForServer: async (url) => events.push(["ready", url]),
      launchBrowser: async () => { events.push("browser.launch"); return browser; },
      runScenario: async ({ url }) => { events.push(["scenario", url]); return { passed: true }; },
      cleanupProcess: async ({ child: owned, port }) => events.push(["cleanup", owned.pid, port]),
      ...overrides,
    },
  };
}

test("UI suite spawns Vite directly with exact arguments and closes browser before the process tree", async () => {
  const runUiSuite = requireApi("runUiSuite");
  const fixture = harness();

  const result = await runUiSuite(fixture.options);

  const spawn = fixture.events[0];
  assert.equal(spawn[0], "spawn");
  assert.equal(spawn[1], process.execPath);
  assert.deepEqual(spawn[2], [
    path.resolve("C:\\repo", "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "15431",
    "--strictPort",
  ]);
  assert.equal(spawn[3].cwd, "C:\\repo");
  assert.equal(fixture.events.at(-2), "browser.close");
  assert.deepEqual(fixture.events.at(-1), ["cleanup", 9876, 15431]);
  assert.equal(result.evidenceClass, "supporting");
});

test("UI suite can serve an existing production build without Vite transforms", async () => {
  const runUiSuite = requireApi("runUiSuite");
  const fixture = harness({ serverMode: "preview" });

  const result = await runUiSuite(fixture.options);

  assert.deepEqual(fixture.events[0][2], [
    path.resolve("C:\\repo", "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "15431",
    "--strictPort",
  ]);
  assert.equal(result.serverMode, "preview");
});

test("startup timeout and scenario failure always clean up owned resources", async () => {
  const runUiSuite = requireApi("runUiSuite");
  const startup = harness({ waitForServer: async () => { throw new Error("startup timeout"); } });
  await assert.rejects(() => runUiSuite(startup.options), /startup timeout/i);
  assert.deepEqual(startup.events.at(-1), ["cleanup", 9876, 15431]);
  assert.ok(!startup.events.includes("browser.launch"));

  const scenario = harness({ runScenario: async () => { throw new Error("scenario failed"); } });
  await assert.rejects(() => runUiSuite(scenario.options), /scenario failed/i);
  assert.equal(scenario.events.at(-2), "browser.close");
  assert.deepEqual(scenario.events.at(-1), ["cleanup", 9876, 15431]);
});

test("browser-close and process cleanup failures make the suite fail", async () => {
  const runUiSuite = requireApi("runUiSuite");
  const closeFailure = harness({
    launchBrowser: async () => ({ close: async () => { throw new Error("browser close failed"); } }),
  });
  await assert.rejects(() => runUiSuite(closeFailure.options), /browser close failed/i);
  assert.deepEqual(closeFailure.events.at(-1), ["cleanup", 9876, 15431]);

  const cleanupFailure = harness({
    cleanupProcess: async () => { throw new Error("process cleanup failed"); },
  });
  await assert.rejects(() => runUiSuite(cleanupFailure.options), /process cleanup failed/i);
});

test("product navigation expands the intentionally collapsed sidebar before locating databases", async () => {
  const ensureNavigationVisible = requireApi("ensureNavigationVisible");
  const events = [];
  const database = {
    async isVisible() { events.push("database.visible"); return false; },
    async waitFor(options) { events.push(["database.wait", options]); },
  };
  const toggle = { async click() { events.push("toggle.click"); } };
  const page = {
    locator(selector) {
      if (selector === ".wb-database-item") return { first: () => database };
      assert.match(selector, /展开导航栏/);
      return {
        filter(options) { assert.deepEqual(options, { visible: true }); return this; },
        first() { return toggle; },
      };
    },
  };

  assert.equal(await ensureNavigationVisible(page, { timeoutMs: 1234 }), true);
  assert.deepEqual(events, [
    "database.visible",
    "toggle.click",
    ["database.wait", { state: "visible", timeout: 1234 }],
  ]);
});

test("UI report envelope preserves raw browser distributions and provenance as supporting evidence", () => {
  const createUiReportEnvelope = requireApi("createUiReportEnvelope");
  const report = createUiReportEnvelope({
    result: {
      scenario: "smoke",
      samples: 5,
      interactionSamples: [10, 20, 30],
      frameIntervals: [16.6, 33.2],
      longTasks: [{ startTime: 1, duration: 55 }],
      mountedRows: 45,
      mountedCells: 540,
      browserHeapBytes: 12_345,
      userAgent: "Chromium test",
      recorderSnapshot: { events: [] },
    },
    fixture: {
      profile: "deterministic-v1",
      version: "1.0.0",
      hash: "a".repeat(64),
      scenario: "smoke",
      debugAssertions: true,
      frontendSource: "devUrl",
      usesExternalDatabase: false,
    },
    environment: { id: "env-1" },
    git: { sourceCommit: "abc", dirty: false, dirtyDiffSha256: "b".repeat(64) },
    runId: "ui-smoke-1",
  });

  assert.equal(report.evidenceClass, "supporting");
  assert.equal(report.provenance.sourceCommit, "abc");
  assert.equal(report.provenance.frontendSource, "devUrl");
  assert.deepEqual(report.cases[0].rawSamples, [10, 20, 30]);
  assert.deepEqual(report.cases[0].frameIntervals, [16.6, 33.2]);
  assert.deepEqual(report.cases[0].longTasks, [{ startTime: 1, duration: 55 }]);
});

test("product scenario dispatch routes import, table search, and Quick Open to dedicated workflows", () => {
  const selectProductScenarioRunner = requireApi("selectProductScenarioRunner");

  const gridRunner = selectProductScenarioRunner("smoke");
  const importRunner = selectProductScenarioRunner("import-10k");
  const tableSearchRunner = selectProductScenarioRunner("table-search-10k-20-no-pk");
  const quickOpenRunner = selectProductScenarioRunner("schema-800x60");

  assert.equal(gridRunner.name, "runGridScenario");
  assert.equal(importRunner.name, "runImportScenario");
  assert.equal(tableSearchRunner.name, "runTableSearchScenario");
  assert.equal(quickOpenRunner.name, "runQuickOpenScenario");
});

test("import workbook fixture contains every row and a deterministic duplicate sentinel", async () => {
  const createImportWorkbookFile = requireApi("createImportWorkbookFile");
  const XLSX = await import("xlsx");

  const file = await createImportWorkbookFile("insert-100x20");
  const workbook = XLSX.read(file.buffer, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    raw: false,
  });

  assert.equal(file.name, "insert-100x20.xlsx");
  assert.equal(rows.length, 101);
  assert.equal(rows[0].length, 20);
  assert.equal(rows.at(-1)[0], rows[1][0]);
});

test("import-10k budget rejects browser long tasks over 100 ms", () => {
  const assertUiScenarioBudget = requireApi("assertUiScenarioBudget");

  assert.doesNotThrow(() => assertUiScenarioBudget({
    scenario: "import-10k",
    longTasks: [{ duration: 99.9 }],
  }));
  assert.throws(
    () => assertUiScenarioBudget({
      scenario: "import-10k",
      longTasks: [{ duration: 100.1 }],
    }),
    /import-10k.*100\.1 ms.*100 ms/u,
  );
});

test("Quick Open budget enforces latency, long-task, mount, and behavior bounds", () => {
  const assertUiScenarioBudget = requireApi("assertUiScenarioBudget");
  const passing = {
    scenario: "schema-800x60",
    quickOpenInputSamples: [12, 18, 49.9],
    openingFeedbackSamples: [8, 49.9],
    firstGridSamples: [80, 199.9],
    longTasks: [{ duration: 50 }],
    mountedQuickOpenResults: 120,
    verification: {
      initialBatch: true,
      scrollExpansion: true,
      keyboardWrap: true,
      fieldSearch: true,
      modeSwitch: true,
    },
  };

  assert.doesNotThrow(() => assertUiScenarioBudget(passing));
  for (const [field, value, message] of [
    ["quickOpenInputSamples", 50, "Quick Open input"],
    ["openingFeedbackSamples", 50, "opening tab feedback"],
    ["firstGridSamples", 200, "first usable grid"],
  ]) {
    assert.throws(
      () => assertUiScenarioBudget({ ...passing, [field]: [value] }),
      new RegExp(message, "i"),
    );
  }
  assert.throws(
    () => assertUiScenarioBudget({ ...passing, longTasks: [{ duration: 50.1 }] }),
    /long task.*50\.1.*50 ms/iu,
  );
  assert.throws(
    () => assertUiScenarioBudget({ ...passing, mountedQuickOpenResults: 121 }),
    /mounted results.*121.*120/iu,
  );
  assert.throws(
    () => assertUiScenarioBudget({
      ...passing,
      verification: { ...passing.verification, keyboardWrap: false },
    }),
    /keyboardWrap/u,
  );
});

test("table search budget requires verified behavior and all three latency targets", () => {
  const assertUiScenarioBudget = requireApi("assertUiScenarioBudget");
  const passing = {
    scenario: "table-search-10k-20-no-pk",
    inputToResultSamples: Array(100).fill(299),
    debounceToFirstResultSamples: Array(100).fill(149),
    nextHitSamples: Array(100).fill(19.9),
    mountedRows: 60,
    verification: {
      selectedCell: true,
      staleInput: true,
      nextPrevious: true,
      clearRestore: true,
      sortRestart: true,
      draftPreserved: true,
    },
  };

  assert.doesNotThrow(() => assertUiScenarioBudget(passing));
  for (const [field, value, message] of [
    ["inputToResultSamples", 301, "input-to-result"],
    ["debounceToFirstResultSamples", 151, "debounce-to-result"],
    ["nextHitSamples", 20.1, "next-hit"],
  ]) {
    assert.throws(
      () => assertUiScenarioBudget({ ...passing, [field]: Array(100).fill(value) }),
      new RegExp(message, "i"),
    );
  }
  assert.throws(
    () => assertUiScenarioBudget({
      ...passing,
      verification: { ...passing.verification, selectedCell: false },
    }),
    /selectedCell/u,
  );
  assert.throws(
    () => assertUiScenarioBudget({ ...passing, mountedRows: 501 }),
    /mounted rows/i,
  );
});

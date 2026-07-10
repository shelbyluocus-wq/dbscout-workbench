import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { computed, reactive, ref } from "vue";

import { createEditState } from "../../src/workbench/editState.js";
import { useGridEditor } from "../../src/workbench/composables/useGridEditor.js";
import { validateRowDraft } from "../../src/workbench/utils/valueValidation.js";
import { renderMarkdown } from "../../src/workbench/utils/markdown.js";
import {
  appendTabPage,
  buildSchemaSearchResults,
} from "../../src/workbench/workspaceState.js";
import {
  createPerfFixtureColumns,
  createPerfFixtureSchema,
  createPerfInsertMatrix,
  perfFixtureHash,
  perfFixtureMetadata,
} from "./fixtures.mjs";
import {
  collectEnvironmentMetadata,
  collectGitProvenance,
  createReportEnvelope,
  summarizeSamples,
  writePerformanceReport,
} from "./report.mjs";

const INTERACTION_WARMUPS = 5;
const INTERACTION_SAMPLES = 100;
const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT_DIRECTORY = path.resolve(path.dirname(MODULE_PATH), "../..");

export async function runMeasuredCase({
  name,
  warmupCount = INTERACTION_WARMUPS,
  sampleCount = INTERACTION_SAMPLES,
  reset = async () => {},
  operation,
  now = () => performance.now(),
} = {}) {
  if (typeof operation !== "function") throw new TypeError(`${name || "benchmark"} operation is required`);
  if (!Number.isInteger(warmupCount) || warmupCount < 0) {
    throw new RangeError("warmupCount must be a non-negative integer");
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new RangeError("sampleCount must be a positive integer");
  }

  for (let index = 0; index < warmupCount; index += 1) {
    await reset({ phase: "warmup", index });
    const startedAt = now();
    await operation({ phase: "warmup", index });
    const endedAt = now();
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
      throw new Error(`${name || "benchmark"} clock produced an invalid warmup interval`);
    }
  }

  const rawSamples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    await reset({ phase: "sample", index });
    const startedAt = now();
    await operation({ phase: "sample", index });
    const endedAt = now();
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
      throw new Error(`${name || "benchmark"} clock produced an invalid sample interval`);
    }
    rawSamples.push(endedAt - startedAt);
  }
  const summary = summarizeSamples(rawSamples);
  return {
    name: String(name || "unnamed"),
    warmupCount,
    sampleCount,
    rawSamples: summary.rawSamples,
    summary: {
      count: summary.count,
      min: summary.min,
      max: summary.max,
      mean: summary.mean,
      median: summary.median,
      p50: summary.p50,
      p95: summary.p95,
    },
  };
}

function seedHash(seed) {
  let hash = 2_166_136_261;
  for (const character of String(seed)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function createInterleavedSchedule({ rounds, seed = "dbscout-performance-v1" } = {}) {
  if (!Number.isInteger(rounds) || rounds < 1) throw new RangeError("rounds must be positive");
  let state = seedHash(seed) || 1;
  const schedule = [];
  for (let round = 0; round < rounds; round += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const baselineFirst = (state >>> 0) % 2 === 0;
    schedule.push(...(baselineFirst
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"]));
  }
  return schedule;
}

export function benchmarkCaseDefinitions() {
  const interaction = (name, scenario) => ({
    name,
    scenario,
    class: "interaction",
    warmupCount: INTERACTION_WARMUPS,
    sampleCount: INTERACTION_SAMPLES,
  });
  return [
    interaction("visual-index-lookup", "rows-100k-500-pk"),
    interaction("arrow-navigation", "rows-100k-500-pk"),
    interaction("row-range-selection", "rows-100k-500-pk"),
    interaction("insert-draft-update-and-paste", "rows-100k-500-pk"),
    {
      name: "import-validation",
      scenario: "insert-500x20",
      class: "heavy",
      warmupCount: 2,
      sampleCount: 10,
    },
    interaction("page-append", "rows-100k-500-pk"),
    interaction("schema-search", "schema-800x60"),
    interaction("agent-delta-aggregation", "agent-20k-character-stream"),
  ];
}

function identityRows(rowCount) {
  return Array.from({ length: rowCount }, (_, index) => ({
    id: String(index + 1),
    field_001: `rows-100k-500-pk|r${String(index + 1).padStart(6, "0")}|c001`,
  }));
}

function createEditorContext(rows, columns) {
  const tab = reactive({
    id: "perf-tab",
    tableName: "perf_rows_100k_500_pk",
    tableKey: "perf-fixture/perf_db/perf_rows_100k_500_pk",
    sessionId: "perf-session",
    database: "perf_db",
    readOnly: false,
    columns,
    primaryKeys: ["id"],
    rows,
    selectedRowKeys: new Set(),
  });
  const gridWrapRef = {
    value: {
      clientHeight: 800,
      scrollTop: 0,
      scrollLeft: 0,
      focus() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0, bottom: 800, left: 0, right: 1440 }; },
    },
  };
  const editor = useGridEditor(
    reactive(createEditState()),
    async () => ({}),
    computed(() => tab),
    gridWrapRef,
    {
      scrollRowIntoView() {},
      scrollCellIntoView() {},
      scrollInsertCellIntoView() {},
    },
    { busy: ref(false), statusText: ref("") },
  );
  return { tab, editor };
}

function withDefinition(name, benchmark) {
  const definition = benchmarkCaseDefinitions().find((entry) => entry.name === name);
  if (!definition) throw new Error(`Missing benchmark definition: ${name}`);
  return { ...definition, ...benchmark };
}

export async function createBenchmarkCases({ rowCount = 100_000 } = {}) {
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new RangeError("rowCount must be positive");
  const rows = identityRows(rowCount);
  const columns = createPerfFixtureColumns("rows-100k-500-pk");
  const { tab, editor } = createEditorContext(rows, columns);
  const schema = createPerfFixtureSchema("schema-800x60").tables;
  const insertMatrix = createPerfInsertMatrix("insert-500x20");
  const insertPasteText = insertMatrix.map((row) => row.join("\t")).join("\n");
  const importColumns = columns.slice(0, 20);
  const importTable = { table_name: "perf_insert_500x20", columns: importColumns, primaryKeys: ["id"] };
  const importDrafts = insertMatrix.map((values) => Object.fromEntries(
    importColumns.map((column, index) => [column.column_name, values[index]]),
  ));
  const appendSize = Math.min(1_000, Math.max(1, rowCount));
  const appendBase = rows.slice(0, Math.max(0, rows.length - appendSize));
  const appendRows = rows.slice(appendBase.length);
  const appendTab = {
    id: "append-tab",
    sessionId: "append-session",
    columns,
    primaryKeys: ["id"],
    rows: appendBase,
    totalRows: rowCount,
    totalRowsExact: true,
    page: 99,
    pageSize: appendSize,
    hasMore: true,
    rowKeyCacheVersion: 0,
  };
  const appendState = { tabs: [appendTab] };
  const deltas = Array.from({ length: 200 }, (_, index) =>
    `${String(index).padStart(3, "0")}:${"x".repeat(95)}\n`);

  let visualSink = -1;
  let arrowSink = "";
  let rangeSink = -1;
  let insertSink = 0;
  let insertPasteRowId = "";
  let importSink = 0;
  let appendSink = 0;
  let schemaSink = 0;
  let agentSink = 0;

  return [
    withDefinition("visual-index-lookup", {
      sourceModule: "src/workbench/composables/useGridEditor.js",
      reset: async () => { visualSink = -1; },
      operation: async () => {
        visualSink = editor.visualRowEntries(tab).at(-1)?.dataIndex ?? -1;
      },
      readSink: () => visualSink,
    }),
    withDefinition("arrow-navigation", {
      sourceModule: "src/workbench/composables/useGridEditor.js",
      reset: async () => {
        editor.clearInsertDraft(tab);
        const middle = Math.floor(rows.length / 2);
        editor.selectedCell.value = { tabId: tab.id, rowKey: `id=${middle + 1}`, column: "id" };
        editor.selectedRange.value = null;
        arrowSink = "";
      },
      operation: async () => {
        editor.navigateCell(1, 0);
        arrowSink = editor.selectedCell.value?.rowKey || "";
      },
      readSink: () => arrowSink,
    }),
    withDefinition("row-range-selection", {
      sourceModule: "src/workbench/composables/useGridEditor.js",
      reset: async () => {
        editor.finishRangeSelection();
        editor.selectedCell.value = null;
        editor.selectedRange.value = null;
        rangeSink = -1;
      },
      operation: async () => {
        editor.startRangeSelection(tab, rows[0], "id", 0, 0, { button: 0, preventDefault() {} });
        editor.extendRangeSelection(tab, rows.at(-1), "field_001", rows.length - 1, 1);
        editor.finishRangeSelection();
        rangeSink = editor.selectedRange.value?.focus?.rowIndex ?? -1;
      },
      readSink: () => rangeSink,
    }),
    withDefinition("insert-draft-update-and-paste", {
      sourceModule: "src/workbench/composables/useGridEditor.js",
      reset: async () => {
        editor.clearInsertDraft(tab);
        editor.selectInsertCell(tab, 0);
        insertPasteRowId = editor.selectedInsertCell.value?.rowId || "";
        insertSink = 0;
      },
      operation: async () => {
        await editor.pasteIntoInsertInput(tab, insertPasteRowId, 0, {
          clipboardData: { getData: () => insertPasteText },
        });
        insertSink = editor.getInsertRows(tab)
          .reduce((total, row) => total + Object.keys(row.draft || {}).length, 0);
      },
      readSink: () => insertSink,
    }),
    withDefinition("import-validation", {
      sourceModule: "src/workbench/utils/valueValidation.js",
      reset: async () => { importSink = 0; },
      operation: async () => {
        const accepted = [];
        for (const draft of importDrafts) {
          const result = validateRowDraft({ table: importTable, rows: [], draft, draftRows: accepted });
          if (result.valid) accepted.push(draft);
        }
        importSink = accepted.length;
      },
      readSink: () => importSink,
    }),
    withDefinition("page-append", {
      sourceModule: "src/workbench/workspaceState.js",
      reset: async () => {
        appendTab.rows = appendBase;
        appendTab.page = 99;
        appendTab.hasMore = true;
        appendTab.fullyLoaded = false;
        appendSink = 0;
      },
      operation: async () => {
        appendTabPage(appendState, appendTab.id, {
          sessionId: appendTab.sessionId,
          rows: appendRows,
          page: 100,
          pageSize: appendSize,
          totalRows: rowCount,
          totalRowsExact: true,
          hasMore: false,
        });
        appendSink = appendTab.rows.length;
      },
      readSink: () => appendSink,
    }),
    withDefinition("schema-search", {
      sourceModule: "src/workbench/workspaceState.js",
      reset: async () => { schemaSink = 0; },
      operation: async () => {
        schemaSink = buildSchemaSearchResults(schema, "perf_schema_table_0800").length;
      },
      readSink: () => schemaSink,
    }),
    withDefinition("agent-delta-aggregation", {
      sourceModule: "src/workbench/utils/markdown.js",
      reset: async () => { agentSink = 0; },
      operation: async () => {
        let content = "";
        for (const delta of deltas) {
          content += delta;
          agentSink = renderMarkdown(content).html.length;
        }
      },
      readSink: () => agentSink,
    }),
  ];
}

export function selectBenchmarkCases(cases, caseNames = []) {
  const requested = [...new Set(
    (Array.isArray(caseNames) ? caseNames : [caseNames])
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  )];
  if (requested.length === 0) return cases;
  const available = new Set(cases.map((entry) => entry.name));
  for (const name of requested) {
    if (!available.has(name)) throw new Error(`Unknown benchmark case: ${name}`);
  }
  const selected = new Set(requested);
  return cases.filter((entry) => selected.has(entry.name));
}

function environmentId(environment) {
  return createHash("sha256").update(JSON.stringify(environment)).digest("hex").slice(0, 16);
}

export async function runWorkbenchBenchmarks({
  label = "before",
  rowCount = 100_000,
  sampleCountOverride = null,
  caseNames = [],
  rootDirectory = ROOT_DIRECTORY,
  outputDirectory = path.resolve(rootDirectory, "output/performance"),
} = {}) {
  const definitions = selectBenchmarkCases(await createBenchmarkCases({ rowCount }), caseNames);
  const results = [];
  for (const benchmark of definitions) {
    const sampleCount = sampleCountOverride == null
      ? benchmark.sampleCount
      : Math.max(1, Number(sampleCountOverride));
    const measured = await runMeasuredCase({
      name: benchmark.name,
      warmupCount: benchmark.warmupCount,
      sampleCount,
      reset: benchmark.reset,
      operation: benchmark.operation,
    });
    results.push({
      ...measured,
      class: benchmark.class,
      scenario: benchmark.scenario,
      fixtureProjection: benchmark.scenario === "rows-100k-500-pk"
        ? "primary-key-and-one-sentinel-column"
        : "complete-declared-case-input",
      sourceModule: benchmark.sourceModule,
      sink: benchmark.readSink(),
    });
  }

  const [git, hash, fixture] = await Promise.all([
    collectGitProvenance({ rootDirectory }),
    perfFixtureHash(),
    perfFixtureMetadata("?perfProfile=deterministic-v1&scenario=smoke"),
  ]);
  const environment = collectEnvironmentMetadata();
  environment.id = environmentId(environment);
  const runId = `workbench-${label}-${new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-")}`;
  const report = createReportEnvelope({
    runId,
    label,
    evidenceClass: "supporting",
    environment,
    fixture: { ...fixture, hash, scenario: "multi-scenario" },
    provenance: {
      ...git,
      debugAssertions: true,
      frontendSource: "node",
      usesExternalDatabase: false,
    },
    scenarioVersion: "1.0.0",
    harnessVersion: "1.0.0",
    warmupCount: INTERACTION_WARMUPS,
    sampleCount: sampleCountOverride ?? INTERACTION_SAMPLES,
    cases: results,
  });
  const reportPath = await writePerformanceReport(report, { outputDirectory });
  return { report, reportPath };
}

function readCliOption(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const argv = process.argv.slice(2);
  const label = readCliOption(argv, "--label", "before");
  const samplesRaw = readCliOption(argv, "--samples", "");
  const samples = samplesRaw === "" ? null : Number(samplesRaw);
  const casesRaw = readCliOption(argv, "--case", "");
  const caseNames = casesRaw.split(",").map((name) => name.trim()).filter(Boolean);
  const result = await runWorkbenchBenchmarks({ label, sampleCountOverride: samples, caseNames });
  process.stdout.write(`${JSON.stringify({
    runId: result.report.runId,
    evidenceClass: result.report.evidenceClass,
    reportPath: result.reportPath,
    cases: result.report.cases.map((entry) => ({
      name: entry.name,
      p50: entry.summary.p50,
      p95: entry.summary.p95,
      samples: entry.sampleCount,
    })),
  }, null, 2)}\n`);
}

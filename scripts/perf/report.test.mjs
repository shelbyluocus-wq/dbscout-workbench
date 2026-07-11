import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const reportModule = await import("./report.mjs").catch(() => ({}));

function requireApi(name) {
  assert.equal(typeof reportModule[name], "function", `report.mjs must export ${name}`);
  return reportModule[name];
}

test("performance summaries retain raw samples and calculate interpolated median and p95", () => {
  const summarizeSamples = requireApi("summarizeSamples");
  const raw = [4, 1, 3, 2];

  const summary = summarizeSamples(raw);

  assert.deepEqual(summary.rawSamples, raw);
  assert.equal(summary.count, 4);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 4);
  assert.equal(summary.mean, 2.5);
  assert.equal(summary.median, 2.5);
  assert.equal(summary.p50, 2.5);
  assert.equal(summary.p95, 3.85);
  assert.deepEqual(raw, [4, 1, 3, 2], "summarization must not reorder caller samples");
  assert.throws(() => summarizeSamples([1, -1]), /non-negative/i);
});

test("improvement percentages preserve direction and reject invalid baselines", () => {
  const improvementPercent = requireApi("improvementPercent");

  assert.equal(improvementPercent(100, 75), 25);
  assert.equal(improvementPercent(75, 100), -33.33333333333333);
  assert.equal(improvementPercent(100, 125, { lowerIsBetter: false }), 25);
  assert.throws(() => improvementPercent(0, 1), /baseline/i);
});

test("environment metadata is stable, explicit, and free of raw CPU arrays", () => {
  const collectEnvironmentMetadata = requireApi("collectEnvironmentMetadata");
  const metadata = collectEnvironmentMetadata({
    platform: "win32",
    release: "10.0.26100",
    arch: "x64",
    cpuModels: ["Example CPU", "Example CPU"],
    totalMemoryBytes: 34_359_738_368,
    nodeVersion: "v22.11.0",
    webview2Version: "140.0.3485.94",
    powerMode: "balanced",
  });

  assert.deepEqual(metadata, {
    platform: "win32",
    osRelease: "10.0.26100",
    architecture: "x64",
    cpuModel: "Example CPU",
    cpuCount: 2,
    totalMemoryBytes: 34_359_738_368,
    nodeVersion: "v22.11.0",
    webview2Version: "140.0.3485.94",
    powerMode: "balanced",
  });
});

test("report envelopes retain provenance and distinguish supporting from authoritative evidence", () => {
  const createReportEnvelope = requireApi("createReportEnvelope");
  const report = createReportEnvelope({
    runId: "run-001",
    label: "before",
    evidenceClass: "supporting",
    environment: { id: "env-001" },
    fixture: {
      profile: "deterministic-v1",
      version: "1.0.0",
      hash: "a".repeat(64),
      scenario: "rows-100k-500-pk",
    },
    provenance: {
      sourceCommit: "abc123",
      dirtyDiffSha256: "b".repeat(64),
      debugAssertions: true,
      frontendSource: "devUrl",
      usesExternalDatabase: false,
    },
    scenarioVersion: "1.0.0",
    harnessVersion: "1.0.0",
    warmupCount: 5,
    sampleCount: 100,
    cases: [{ name: "arrow-navigation", rawSamples: [1, 2, 3] }],
  });

  assert.equal(report.schemaVersion, "1.0.0");
  assert.equal(report.evidenceClass, "supporting");
  assert.equal(report.fixture.hash, "a".repeat(64));
  assert.equal(report.provenance.frontendSource, "devUrl");
  assert.equal(report.provenance.usesExternalDatabase, false);
  assert.deepEqual(report.cases[0].rawSamples, [1, 2, 3]);
  assert.throws(
    () => createReportEnvelope({ ...report, evidenceClass: "final" }),
    /evidence class/i,
  );
  assert.throws(() => createReportEnvelope({ ...report, sampleCount: 0 }), /sampleCount/i);
  assert.throws(() => createReportEnvelope({ ...report, warmupCount: -1 }), /warmupCount/i);
  assert.throws(
    () => createReportEnvelope({ ...report, provenance: { ...report.provenance, sourceCommit: "" } }),
    /sourceCommit/i,
  );
});

test("regression exit codes are non-zero only when a gate was explicitly requested", () => {
  const regressionGateExitCode = requireApi("regressionGateExitCode");

  assert.equal(regressionGateExitCode({ requested: false, regressions: ["slow"] }), 0);
  assert.equal(regressionGateExitCode({ requested: true, regressions: [] }), 0);
  assert.equal(regressionGateExitCode({ requested: true, regressions: ["slow"] }), 1);
});

test("git provenance binds the source commit and complete dirty-state bytes", async () => {
  const collectGitProvenance = requireApi("collectGitProvenance");
  const outputs = new Map([
    ["rev-parse HEAD", "abc123\n"],
    ["status --porcelain=v1 -z --untracked-files=all", " M tracked.js\0?? new.js\0"],
    ["diff --binary HEAD", "diff bytes\n"],
  ]);
  const newFileBytes = Buffer.from("new file contents");
  const provenance = await collectGitProvenance({
    rootDirectory: "C:\\repo",
    runGit: async (args) => outputs.get(args.join(" ")),
    readFileBytes: async (filePath) => {
      assert.equal(filePath, "C:\\repo\\new.js");
      return newFileBytes;
    },
  });
  const newFileHash = createHash("sha256").update(newFileBytes).digest("hex");
  const dirtyBytes = ` M tracked.js\0?? new.js\0\0diff bytes\n\0new.js:${newFileHash}\n`;

  assert.equal(provenance.sourceCommit, "abc123");
  assert.equal(provenance.dirty, true);
  assert.equal(
    provenance.dirtyDiffSha256,
    createHash("sha256").update(dirtyBytes).digest("hex"),
  );
});

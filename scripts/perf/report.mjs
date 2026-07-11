import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const REPORT_SCHEMA_VERSION = "1.0.0";

function finiteSamples(samples) {
  if (!Array.isArray(samples) || samples.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Performance samples must be an array of finite numbers");
  }
  if (samples.some((value) => value < 0)) {
    throw new RangeError("Performance samples must be non-negative durations");
  }
  return samples.map(Number);
}

function quantile(sorted, percentile) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return Number(value.toFixed(12));
}

export function summarizeSamples(samples) {
  const rawSamples = finiteSamples(samples);
  const sorted = [...rawSamples].sort((left, right) => left - right);
  const count = rawSamples.length;
  const mean = count === 0
    ? null
    : rawSamples.reduce((sum, value) => sum + value, 0) / count;
  const p50 = quantile(sorted, 0.5);
  return {
    rawSamples,
    count,
    min: count === 0 ? null : sorted[0],
    max: count === 0 ? null : sorted.at(-1),
    mean,
    median: p50,
    p50,
    p95: quantile(sorted, 0.95),
  };
}

export function improvementPercent(baseline, candidate, { lowerIsBetter = true } = {}) {
  if (!Number.isFinite(baseline) || baseline <= 0) {
    throw new RangeError("Improvement baseline must be a positive finite number");
  }
  if (!Number.isFinite(candidate)) {
    throw new TypeError("Improvement candidate must be a finite number");
  }
  return lowerIsBetter
    ? ((baseline - candidate) / baseline) * 100
    : ((candidate - baseline) / baseline) * 100;
}

export function collectEnvironmentMetadata(overrides = {}) {
  const cpus = overrides.cpuModels || os.cpus().map((cpu) => cpu.model);
  return {
    platform: overrides.platform || process.platform,
    osRelease: overrides.release || os.release(),
    architecture: overrides.arch || process.arch,
    cpuModel: cpus[0] || "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: overrides.totalMemoryBytes ?? os.totalmem(),
    nodeVersion: overrides.nodeVersion || process.version,
    webview2Version: overrides.webview2Version || "unknown",
    powerMode: overrides.powerMode || "unknown",
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredCount(value, name, minimum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return numeric;
}

function requiredSha256(value, name) {
  requiredString(value, name);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${name} must be a lowercase SHA-256`);
  return value;
}

export function createReportEnvelope(input) {
  const evidenceClass = requiredString(input?.evidenceClass, "evidence class");
  if (!new Set(["supporting", "authoritative"]).has(evidenceClass)) {
    throw new RangeError(`Unsupported evidence class: ${evidenceClass}`);
  }
  if (!Array.isArray(input.cases)) throw new TypeError("cases must be an array");
  if (!input.fixture || !input.provenance || !input.environment) {
    throw new TypeError("environment, fixture, and provenance are required");
  }
  requiredString(input.environment.id, "environment.id");
  for (const field of ["profile", "version", "scenario"]) {
    requiredString(input.fixture[field], `fixture.${field}`);
  }
  requiredSha256(input.fixture.hash, "fixture.hash");
  requiredString(input.provenance.sourceCommit, "provenance.sourceCommit");
  requiredSha256(input.provenance.dirtyDiffSha256, "provenance.dirtyDiffSha256");
  requiredString(input.provenance.frontendSource, "provenance.frontendSource");
  if (typeof input.provenance.debugAssertions !== "boolean") {
    throw new TypeError("provenance.debugAssertions must be boolean");
  }
  if (typeof input.provenance.usesExternalDatabase !== "boolean") {
    throw new TypeError("provenance.usesExternalDatabase must be boolean");
  }
  const warmupCount = requiredCount(input.warmupCount, "warmupCount", 0);
  const sampleCount = requiredCount(input.sampleCount, "sampleCount", 1);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: requiredString(input.runId, "runId"),
    label: requiredString(input.label, "label"),
    evidenceClass,
    environment: structuredClone(input.environment),
    fixture: structuredClone(input.fixture),
    provenance: structuredClone(input.provenance),
    scenarioVersion: requiredString(input.scenarioVersion, "scenarioVersion"),
    harnessVersion: requiredString(input.harnessVersion, "harnessVersion"),
    warmupCount,
    sampleCount,
    cases: structuredClone(input.cases),
  };
}

export async function writePerformanceReport(
  report,
  { outputDirectory = path.resolve("output/performance"), fileName = `${report.runId}.json` } = {},
) {
  const target = path.resolve(outputDirectory, fileName);
  const relative = path.relative(path.resolve(outputDirectory), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Performance report path must remain inside the output directory");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}

export function regressionGateExitCode({ requested = false, regressions = [] } = {}) {
  return requested && Array.isArray(regressions) && regressions.length > 0 ? 1 : 0;
}

function runGitDefault(args, { cwd }) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function collectGitProvenance({
  rootDirectory = process.cwd(),
  runGit = runGitDefault,
  readFileBytes = readFile,
} = {}) {
  const [commit, status, diff] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd: rootDirectory }),
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: rootDirectory }),
    runGit(["diff", "--binary", "HEAD"], { cwd: rootDirectory }),
  ]);
  const statusText = String(status);
  const untrackedPaths = statusText
    .split(statusText.includes("\0") ? "\0" : /\r?\n/u)
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter(Boolean)
    .sort();
  const untrackedManifest = [];
  for (const relativePath of untrackedPaths) {
    const absolutePath = path.resolve(rootDirectory, relativePath);
    const containment = path.relative(path.resolve(rootDirectory), absolutePath);
    if (containment.startsWith("..") || path.isAbsolute(containment)) {
      throw new Error(`Untracked path escapes source root: ${relativePath}`);
    }
    const bytes = await readFileBytes(absolutePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    untrackedManifest.push(`${relativePath.replaceAll("\\", "/")}:${hash}`);
  }
  const dirtyBytes = `${statusText}\0${diff}\0${untrackedManifest.join("\n")}${untrackedManifest.length ? "\n" : ""}`;
  return {
    sourceCommit: String(commit).trim(),
    dirty: statusText.trim().length > 0,
    dirtyDiffSha256: createHash("sha256").update(dirtyBytes).digest("hex"),
  };
}

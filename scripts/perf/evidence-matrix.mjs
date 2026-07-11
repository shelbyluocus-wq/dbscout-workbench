import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_FINDING_IDS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
);

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX_PATH = path.join(MODULE_DIRECTORY, "evidence-matrix.json");
const DEFAULT_SCHEMA_PATH = path.join(MODULE_DIRECTORY, "evidence-matrix.schema.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const COMPLETION_BLOCKED_STATUSES = new Set([
  "PENDING",
  "SKIP",
  "missing",
  "indirect",
  "INCONCLUSIVE",
  "REGRESSION",
]);
const SCHEMA_STATUSES = new Set(["PENDING", "PASS", "NOT_REQUIRED", "INCONCLUSIVE", "REGRESSION"]);
const REQUIRED_FINDING_FIELDS = [
  "finding",
  "task",
  "correctnessTest",
  "performanceScenario",
  "fixtureVersion",
  "harnessVersion",
  "scenarioVersion",
  "beforeArtifact",
  "environmentId",
  "status",
  "note",
];

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new TypeError(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function validateRelativeArtifact(value, field, { allowEmpty = false } = {}) {
  requireString(value, field, { allowEmpty });
  if (value === "" && allowEmpty) return;
  const normalized = value.replaceAll("\\", "/");
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    throw new RangeError(`${field} must be a safe relative artifact path`);
  }
}

function validateHash(value, field, { allowEmpty = false } = {}) {
  requireString(value, field, { allowEmpty });
  if (value === "" && allowEmpty) return;
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

function validateDiagnosticBaseline(value) {
  requireObject(value, "diagnosticBaseline");
  const expectedFields = new Set([
    "manifestArtifact",
    "manifestSha256",
    "sourceCommit",
    "evidenceClass",
  ]);
  for (const field of Object.keys(value)) {
    if (!expectedFields.has(field)) {
      throw new RangeError(`diagnosticBaseline contains unsupported field ${field}`);
    }
  }
  for (const field of expectedFields) {
    if (!(field in value)) throw new TypeError(`diagnosticBaseline.${field} is required`);
  }
  validateRelativeArtifact(value.manifestArtifact, "diagnosticBaseline.manifestArtifact");
  validateHash(value.manifestSha256, "diagnosticBaseline.manifestSha256");
  requireString(value.sourceCommit, "diagnosticBaseline.sourceCommit");
  if (!SOURCE_COMMIT_PATTERN.test(value.sourceCommit)) {
    throw new TypeError("diagnosticBaseline.sourceCommit must be a lowercase 40-character commit");
  }
  if (value.evidenceClass !== "supporting") {
    throw new RangeError("diagnosticBaseline.evidenceClass must remain supporting");
  }
}

function validateSchemaShape(matrix, mode) {
  requireObject(matrix, "evidence matrix");
  for (const field of ["schemaVersion", "fixtureVersion", "harnessVersion", "scenarioVersion"]) {
    requireString(matrix[field], field);
  }
  validateDiagnosticBaseline(matrix.diagnosticBaseline);
  if (!Array.isArray(matrix.findings)) throw new TypeError("findings must be an array");

  const seen = new Set();
  for (const finding of matrix.findings) {
    requireObject(finding, "finding");
    requireString(finding.id, "id");
    if (!EXPECTED_FINDING_IDS.includes(finding.id)) {
      throw new RangeError(`Unknown finding ID ${finding.id}`);
    }
    if (seen.has(finding.id)) throw new RangeError(`Duplicate finding ID ${finding.id}`);
    seen.add(finding.id);
    for (const field of REQUIRED_FINDING_FIELDS) requireString(finding[field], field);
    requireString(finding.afterArtifact, "afterArtifact", { allowEmpty: true });
    validateRelativeArtifact(finding.beforeArtifact, "beforeArtifact");
    validateRelativeArtifact(finding.afterArtifact, "afterArtifact", { allowEmpty: true });
    validateHash(finding.beforeSha256, "beforeSha256", { allowEmpty: finding.status === "PENDING" });
    validateHash(finding.afterSha256, "afterSha256", { allowEmpty: finding.status === "PENDING" });
    if (mode === "completion" && COMPLETION_BLOCKED_STATUSES.has(finding.status)) {
      throw new Error(`Completion evidence rejects status ${finding.status} for ${finding.id}`);
    }
    if (!SCHEMA_STATUSES.has(finding.status)) {
      throw new RangeError(`Unsupported status ${finding.status} for ${finding.id}`);
    }
  }
  const missing = EXPECTED_FINDING_IDS.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new RangeError(`Missing finding IDs: ${missing.join(", ")}`);
  if (matrix.findings.length !== EXPECTED_FINDING_IDS.length) {
    throw new RangeError(`findings must contain exactly ${EXPECTED_FINDING_IDS.length} rows`);
  }
}

async function verifyCompletionArtifacts(matrix, baseDirectory) {
  const manifestPath = path.resolve(baseDirectory, matrix.diagnosticBaseline.manifestArtifact);
  const manifestRelative = path.relative(path.resolve(baseDirectory), manifestPath);
  if (manifestRelative.startsWith("..") || path.isAbsolute(manifestRelative)) {
    throw new RangeError("diagnosticBaseline.manifestArtifact must remain inside the evidence root");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestHash !== matrix.diagnosticBaseline.manifestSha256) {
    throw new Error("Diagnostic baseline manifest hash mismatch");
  }

  for (const finding of matrix.findings) {
    for (const field of ["fixtureVersion", "harnessVersion", "scenarioVersion"]) {
      if (finding[field] !== matrix[field]) {
        throw new Error(`${finding.id} ${field} is stale: ${finding[field]} != ${matrix[field]}`);
      }
    }
    for (const side of ["before", "after"]) {
      const artifactField = `${side}Artifact`;
      const hashField = `${side}Sha256`;
      validateRelativeArtifact(finding[artifactField], artifactField);
      validateHash(finding[hashField], hashField);
      const absolute = path.resolve(baseDirectory, finding[artifactField]);
      const relative = path.relative(path.resolve(baseDirectory), absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new RangeError(`${artifactField} must remain inside the evidence root`);
      }
      const bytes = await readFile(absolute);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== finding[hashField]) {
        throw new Error(`${finding.id} ${side} artifact hash mismatch`);
      }
    }
  }
  return matrix;
}

export function validateEvidenceMatrix(matrix, { mode = "schema", baseDirectory = process.cwd() } = {}) {
  if (!new Set(["schema", "completion"]).has(mode)) {
    throw new RangeError(`Unknown evidence validation mode: ${mode}`);
  }
  if (mode === "completion") {
    return Promise.resolve().then(() => {
      validateSchemaShape(matrix, mode);
      return verifyCompletionArtifacts(matrix, baseDirectory);
    });
  }
  validateSchemaShape(matrix, mode);
  return matrix;
}

export async function loadEvidenceMatrix({
  matrixPath = DEFAULT_MATRIX_PATH,
  schemaPath = DEFAULT_SCHEMA_PATH,
  mode = "schema",
  baseDirectory = path.resolve(MODULE_DIRECTORY, "../.."),
} = {}) {
  const [matrixText, schemaText] = await Promise.all([
    readFile(matrixPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);
  const schema = JSON.parse(schemaText);
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("Evidence matrix schema must use JSON Schema draft 2020-12");
  }
  const matrix = JSON.parse(matrixText);
  return await validateEvidenceMatrix(matrix, { mode, baseDirectory });
}

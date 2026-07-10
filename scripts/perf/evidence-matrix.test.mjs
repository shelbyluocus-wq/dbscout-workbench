import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const matrixModule = await import("./evidence-matrix.mjs").catch(() => ({}));

function requireApi(name) {
  assert.equal(typeof matrixModule[name], "function", `evidence-matrix.mjs must export ${name}`);
  return matrixModule[name];
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function validFinding(id) {
  return {
    id,
    finding: `Finding ${id}`,
    task: "Task 5",
    correctnessTest: "node --test example.test.mjs",
    performanceScenario: "rows-100k-500-pk",
    fixtureVersion: "1.0.0",
    harnessVersion: "1.0.0",
    scenarioVersion: "1.0.0",
    beforeArtifact: "evidence/before.json",
    beforeSha256: "",
    afterArtifact: "",
    afterSha256: "",
    environmentId: "env-local",
    status: "PENDING",
    note: "Awaiting authoritative A/B evidence",
  };
}

function validMatrix() {
  return {
    schemaVersion: "1.0.0",
    fixtureVersion: "1.0.0",
    harnessVersion: "1.0.0",
    scenarioVersion: "1.0.0",
    findings: Array.from({ length: 20 }, (_, index) =>
      validFinding(`F${String(index + 1).padStart(2, "0")}`),
    ),
  };
}

test("checked-in matrix and schema define every stable finding exactly once", async () => {
  const loadEvidenceMatrix = requireApi("loadEvidenceMatrix");
  const matrix = await loadEvidenceMatrix({ mode: "schema" });

  assert.deepEqual(
    matrix.findings.map((finding) => finding.id),
    Array.from({ length: 20 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
  );
  const schema = JSON.parse(
    await readFile(new URL("./evidence-matrix.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("schema validation rejects duplicate and unknown finding IDs", () => {
  const validateEvidenceMatrix = requireApi("validateEvidenceMatrix");
  const duplicate = validMatrix();
  duplicate.findings[19].id = "F01";
  assert.throws(() => validateEvidenceMatrix(duplicate, { mode: "schema" }), /duplicate.*F01/i);

  const unknown = validMatrix();
  unknown.findings[19].id = "F21";
  assert.throws(() => validateEvidenceMatrix(unknown, { mode: "schema" }), /unknown.*F21/i);
});

test("schema validation rejects missing contracts, unsafe paths, and malformed hashes", () => {
  const validateEvidenceMatrix = requireApi("validateEvidenceMatrix");
  for (const field of ["task", "correctnessTest", "performanceScenario", "environmentId"]) {
    const matrix = validMatrix();
    matrix.findings[0][field] = "";
    assert.throws(() => validateEvidenceMatrix(matrix, { mode: "schema" }), new RegExp(field, "i"));
  }

  const unsafe = validMatrix();
  unsafe.findings[0].beforeArtifact = "../outside.json";
  assert.throws(() => validateEvidenceMatrix(unsafe, { mode: "schema" }), /relative artifact/i);

  const malformed = validMatrix();
  malformed.findings[0].beforeSha256 = "not-a-hash";
  assert.throws(() => validateEvidenceMatrix(malformed, { mode: "schema" }), /sha-?256/i);
});

test("completion mode verifies artifacts, hashes, versions, and rejects incomplete statuses", async () => {
  const validateEvidenceMatrix = requireApi("validateEvidenceMatrix");
  const root = await mkdtemp(path.join(os.tmpdir(), "dbscout-evidence-"));
  await mkdir(path.join(root, "evidence"));
  const before = "before evidence";
  const after = "after evidence";
  await writeFile(path.join(root, "evidence", "before.json"), before);
  await writeFile(path.join(root, "evidence", "after.json"), after);

  const matrix = validMatrix();
  for (const finding of matrix.findings) {
    Object.assign(finding, {
      beforeSha256: sha256(before),
      afterArtifact: "evidence/after.json",
      afterSha256: sha256(after),
      status: "PASS",
    });
  }
  await validateEvidenceMatrix(matrix, { mode: "completion", baseDirectory: root });

  for (const status of ["PENDING", "SKIP", "missing", "indirect", "INCONCLUSIVE"]) {
    const invalid = structuredClone(matrix);
    invalid.findings[0].status = status;
    await assert.rejects(
      () => validateEvidenceMatrix(invalid, { mode: "completion", baseDirectory: root }),
      new RegExp(status, "i"),
    );
  }

  const stale = structuredClone(matrix);
  stale.findings[0].fixtureVersion = "0.9.0";
  await assert.rejects(
    () => validateEvidenceMatrix(stale, { mode: "completion", baseDirectory: root }),
    /fixtureVersion/i,
  );

  const wrongHash = structuredClone(matrix);
  wrongHash.findings[0].afterSha256 = "0".repeat(64);
  await assert.rejects(
    () => validateEvidenceMatrix(wrongHash, { mode: "completion", baseDirectory: root }),
    /hash mismatch/i,
  );
});

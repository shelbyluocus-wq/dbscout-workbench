import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const fixtures = await import("./fixtures.mjs").catch(() => ({}));
const browserFixture = await import("../../src/workbench/mock/perfFixture.js").catch(() => ({}));

function requireApi(module, name, owner) {
  assert.equal(typeof module[name], "function", `${owner} must export ${name}`);
  return module[name];
}

test("Node and browser fixture modules share canonical bytes and SHA-256", async () => {
  const nodeCanonical = requireApi(fixtures, "canonicalPerfFixtureText", "fixtures.mjs");
  const nodeMetadata = requireApi(fixtures, "perfFixtureMetadata", "fixtures.mjs");
  const browserCanonical = requireApi(browserFixture, "canonicalPerfFixtureText", "perfFixture.js");
  const browserHash = requireApi(browserFixture, "perfFixtureHash", "perfFixture.js");

  const canonical = nodeCanonical();
  const expectedHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  assert.equal(browserCanonical(), canonical);
  assert.equal(
    (await nodeMetadata("?perfProfile=deterministic-v1&scenario=smoke")).hash,
    expectedHash,
  );
  assert.equal(await browserHash(), expectedHash);
});

test("two independent generations are deep-equal with fixed sentinels", () => {
  const pageFor = requireApi(fixtures, "createPerfFixturePage", "fixtures.mjs");
  const first = pageFor("rows-10k-40-pk", { offset: 499, limit: 2 });
  const second = pageFor("rows-10k-40-pk", { offset: 499, limit: 2 });

  assert.deepEqual(first, second);
  assert.equal(first.rows[0].id, "500");
  assert.equal(first.rows[1].field_039, "rows-10k-40-pk|r000501|c039");
});

test("ordinary and performance mock row sources contain no Math.random", async () => {
  const [ordinaryRows, fixtureSource] = await Promise.all([
    readFile(new URL("../../src/workbench/mock/mockRows.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/workbench/mock/perfFixture.js", import.meta.url), "utf8").catch(() => ""),
  ]);

  assert.doesNotMatch(ordinaryRows, /Math\.random\s*\(/);
  assert.doesNotMatch(fixtureSource, /Math\.random\s*\(/);
});

test("ordinary mock rows are deterministic across independent generations", async () => {
  const { generateMockRows } = await import("../../src/workbench/mock/mockRows.js");

  assert.deepEqual(generateMockRows(), generateMockRows());
});

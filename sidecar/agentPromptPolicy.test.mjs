import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(__dirname, "agent-runner.mjs"), "utf8");

test("agent prompt keeps database profile internal and uses project files first for project-backed config work", () => {
  assert.match(runner, /PROJECT_FIRST_CONFIG_POLICY/);
  assert.match(runner, /PROJECT_AMBIGUITY_POLICY/);
  assert.match(runner, /project-backed configuration, resource, JSON, exported asset, or workflow questions/);
  assert.match(runner, /Use dbscout-project tools before database profile tools/);
  assert.match(runner, /Do not present a complete configuration checklist from database profile evidence alone/);
  assert.match(runner, /ask a concise clarification question before answering as if certain/);
  assert.match(runner, /Database profile evidence is internal context/);
  assert.doesNotMatch(runner, /Use the database profile tools first for database-wide understanding/);
});

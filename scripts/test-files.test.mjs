import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("collectTestFiles recursively returns only ordered test modules", async (t) => {
  const module = await import("./test-files.mjs").catch(() => ({}));
  assert.equal(
    typeof module.collectTestFiles,
    "function",
    "collector module is unavailable",
  );
  const { collectTestFiles } = module;
  const root = await mkdtemp(path.join(tmpdir(), "dbscout-tests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "a.test.js"), ""),
    writeFile(path.join(root, "ignored.js"), ""),
    writeFile(path.join(root, "ignored.test.jsx"), ""),
    writeFile(path.join(root, "nested", "b.test.mjs"), ""),
    writeFile(path.join(root, "nested", "ignored.test.js.backup"), ""),
    writeFile(path.join(root, "node_modules", "hidden.test.js"), ""),
  ]);

  const files = await collectTestFiles(root, {
    ignoredDirectories: new Set(["node_modules", "resources"]),
  });
  assert.deepEqual(
    files.map((file) => path.relative(root, file).replaceAll("\\", "/")),
    ["a.test.js", "nested/b.test.mjs"],
  );
});

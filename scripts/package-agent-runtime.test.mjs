import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { packageAgentRuntime } from "./package-agent-runtime.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbscout-agent-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, "sources");
  fs.mkdirSync(sources, { recursive: true });
  const nodePath = path.join(sources, "node.exe");
  const cliPath = path.join(sources, "claude-code-native.exe");
  fs.writeFileSync(nodePath, "portable-node-fixture\n".repeat(100));
  fs.writeFileSync(cliPath, "native-cli-fixture\n".repeat(120));
  const entries = [
    { sourcePath: nodePath, name: "node/node.exe" },
    { sourcePath: cliPath, name: "claude-code-native.exe" },
  ];
  return { root, nodePath, cliPath, entries };
}

test("packages the two runtime executables and writes the independent manifest", async (t) => {
  const { root, entries } = fixture(t);
  const outputDirectory = path.join(root, "release");

  const result = await packageAgentRuntime({
    root,
    version: 3,
    minAppVersion: "0.1.29",
    target: "win-x64",
    outputDirectory,
    entries,
  });

  assert.equal(path.basename(result.packagePath), "agent-runtime-v3-win-x64.zip");
  assert.equal(result.manifest.version, 3);
  assert.equal(result.manifest.minAppVersion, "0.1.29");
  assert.equal(result.manifest.package, "agent-runtime-v3-win-x64.zip");
  assert.match(result.manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.size, fs.statSync(result.packagePath).size);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.manifestPath, "utf8")),
    result.manifest,
  );
  const archive = fs.readFileSync(result.packagePath);
  assert.ok(archive.includes(Buffer.from("node/node.exe")));
  assert.ok(archive.includes(Buffer.from("claude-code-native.exe")));
});

test("produces deterministic archives and treats an identical version as unchanged", async (t) => {
  const { root, entries } = fixture(t);
  const firstOutput = path.join(root, "first");
  const secondOutput = path.join(root, "second");
  const options = {
    root,
    version: 4,
    minAppVersion: "0.1.29",
    target: "win-x64",
    entries,
  };

  const first = await packageAgentRuntime({ ...options, outputDirectory: firstOutput });
  const second = await packageAgentRuntime({ ...options, outputDirectory: secondOutput });
  const repeated = await packageAgentRuntime({ ...options, outputDirectory: firstOutput });

  assert.equal(first.manifest.sha256, second.manifest.sha256);
  assert.equal(first.manifest.size, second.manifest.size);
  assert.equal(repeated.unchanged, true);
});

test("requires a version bump when package content changes", async (t) => {
  const { root, cliPath, entries } = fixture(t);
  const outputDirectory = path.join(root, "release");
  const options = {
    root,
    version: 5,
    minAppVersion: "0.1.29",
    target: "win-x64",
    outputDirectory,
    entries,
  };
  const first = await packageAgentRuntime(options);
  const originalManifest = fs.readFileSync(first.manifestPath, "utf8");
  fs.appendFileSync(cliPath, "changed");

  await assert.rejects(
    packageAgentRuntime(options),
    /already exists with different content; bump --version/,
  );
  assert.equal(fs.readFileSync(first.manifestPath, "utf8"), originalManifest);
});

test("rejects publishing an older runtime version", async (t) => {
  const { root, entries } = fixture(t);
  const outputDirectory = path.join(root, "release");
  await packageAgentRuntime({
    root,
    version: 8,
    minAppVersion: "0.1.29",
    target: "win-x64",
    outputDirectory,
    entries,
  });

  await assert.rejects(
    packageAgentRuntime({
      root,
      version: 7,
      minAppVersion: "0.1.29",
      target: "win-x64",
      outputDirectory,
      entries,
    }),
    /cannot go backwards/,
  );
});

test("rejects invalid runtime and minimum application versions", async (t) => {
  const { root, entries } = fixture(t);
  await assert.rejects(
    packageAgentRuntime({
      root,
      version: "1.5",
      minAppVersion: "0.1.29",
      target: "win-x64",
      outputDirectory: path.join(root, "bad-runtime-version"),
      entries,
    }),
    /positive integer/,
  );
  await assert.rejects(
    packageAgentRuntime({
      root,
      version: 1,
      minAppVersion: "latest",
      target: "win-x64",
      outputDirectory: path.join(root, "bad-app-version"),
      entries,
    }),
    /numeric application version/,
  );
});

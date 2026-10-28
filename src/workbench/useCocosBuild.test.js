import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLineTone,
  buildRequest,
  cocosBuildConfirmOptions,
  composeDrivers,
  createReleaseBuildDriver,
  useCocosBuildTool,
} from "./composables/useCocosBuild.js";

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

const PROJECT = Object.freeze({ exists: true, engine: { version: "3.8.8", family: 3 }, editorExists: true, editorVersion: "3.8.8", qaGuard: true });

function fakeBackend({ project = PROJECT, result = { outcome: "success", exitCode: 36 }, lines = [] } = {}) {
  const calls = [];
  return {
    calls,
    inspect: async (options) => {
      calls.push(["inspect", options.projectPath]);
      return project;
    },
    findEditors: async () => [{ version: "3.8.8", path: "D:\\creator\\CocosCreator.exe", source: "nearby" }],
    outputStatus: async () => ({ exists: false, entries: 0 }),
    build: async (request, onLine) => {
      calls.push(["build", request]);
      for (const line of lines) onLine(line);
      return result;
    },
    reveal: async () => true,
  };
}

function capture() {
  const logs = [];
  const progress = [];
  return {
    logs,
    progress,
    io: {
      signal: new AbortController().signal,
      log: (text, tone) => logs.push([text, tone]),
      progress: (fraction) => progress.push(fraction),
      wait: () => Promise.resolve(),
    },
  };
}

function context(overrides = {}) {
  return {
    runId: "run-1",
    attempt: 1,
    demo: {},
    build: {
      projectPath: "D:\\tw\\jswz",
      editorPath: "D:\\creator\\CocosCreator.exe",
      version: "3.8.8",
      platform: "android",
      configPath: "",
      outputName: "",
      debug: false,
      md5Cache: true,
      qaGuard: true,
    },
    ...overrides,
  };
}

test("the build step runs the real build through the backend and keeps its output", async () => {
  const backend = fakeBackend({
    lines: [{ stream: "out", line: "[Build] Compile scripts done" }, { stream: "err", line: "warning: texture" }],
    result: { outcome: "success", exitCode: 36, outputDir: "D:\\tw\\jswz\\build\\android", qa: { status: "passed", checked: 1286, findings: [] } },
  });
  const driver = createReleaseBuildDriver({ backend });
  assert.equal(driver.handles("build.cocos"), true);
  assert.equal(driver.handles("client.sync"), false);
  const { io, logs, progress } = capture();
  const result = await driver.run("build.cocos", context(), io);
  assert.deepEqual([result.exitCode, result.qaChecked, result.engineVersion, result.platform], [36, 1286, "3.8.8", "android"]);
  assert.deepEqual(logs, [["[Build] Compile scripts done", ""], ["warning: texture", "warning"]]);
  assert.deepEqual(progress, [null], "Cocos reports no percentage, so the bar only moves");
  const [, request] = backend.calls.find(([kind]) => kind === "build");
  assert.deepEqual([request.family, request.qaGuard, request.platform], [3, true, "android"]);
  assert.equal("simulate" in request, false);
});

test("a build that cannot start, fails or ships QA tooling fails the step with its reason", async () => {
  const precheck = createReleaseBuildDriver({ backend: fakeBackend({ project: { exists: false } }) });
  await assert.rejects(precheck.run("build.cocos", context(), capture().io), (error) => error.code === "buildPrecheck"
    && error.result.problems[0].code === "projectMissing");
  const failed = createReleaseBuildDriver({ backend: fakeBackend({ result: { outcome: "buildError", exitCode: 34 } }) });
  await assert.rejects(failed.run("build.cocos", context(), capture().io), (error) => error.code === "buildFailed"
    && error.exitCode === 34 && error.result.exitCode === 34);
  const qa = createReleaseBuildDriver({
    backend: fakeBackend({ result: { outcome: "success", exitCode: 36, qa: { status: "findings", findings: ["main.js: JSWZQAToolkit"] } } }),
  });
  await assert.rejects(qa.run("build.cocos", context(), capture().io), (error) => error.code === "qaFindings");
  const stopped = createReleaseBuildDriver({ backend: fakeBackend({ result: { outcome: "cancelled" } }) });
  await assert.rejects(stopped.run("build.cocos", context(), capture().io), (error) => error.code === "cancelled");
  // Only the browser preview's mock is ever asked to fail.
  const backend = fakeBackend();
  await createReleaseBuildDriver({ backend, simulateFailure: (ctx) => ctx.attempt === 1 }).run("build.cocos", context(), capture().io);
  assert.equal(backend.calls.find(([kind]) => kind === "build")[1].simulate, "failure");
});

test("drivers are chosen per task; requests and log tones follow the tool", async () => {
  const seen = [];
  const composed = composeDrivers(
    { handles: (id) => id === "build.cocos", run: async (id) => seen.push(["real", id]) },
    { run: async (id) => seen.push(["demo", id]) },
  );
  await composed.run("build.cocos");
  await composed.run("db.sync");
  assert.deepEqual(seen, [["real", "build.cocos"], ["demo", "db.sync"]]);
  assert.equal(buildRequest({ version: "3.8.8" }, { jobId: "j", engineVersion: "2.4.13" }).family, 2, "the project's engine decides");
  assert.equal(buildRequest({ version: "" }, { jobId: "j" }).family, 3);
  assert.equal(buildLineTone({ stream: "out", line: "[Error] Build failed" }), "error");
  assert.equal(buildLineTone({ stream: "info", line: "> CocosCreator --project" }), "muted");
  assert.equal(buildLineTone({ stream: "out", line: "Build success" }), "");
});

test("the build confirmation names what it uses and warns before overwriting", () => {
  const options = context().build;
  const plain = cocosBuildConfirmOptions({ options, project: PROJECT, outputDir: "D:\\tw\\jswz\\build\\android", output: { exists: false } });
  assert.equal(plain.danger, false);
  assert.equal(plain.items.length, 4);
  assert.ok(plain.items.some((item) => item.includes("D:\\tw\\jswz\\build\\android")));
  const direct = cocosBuildConfirmOptions({ options, project: PROJECT, outputDir: "x", output: { exists: true, entries: 12 }, direct: true, preview: true });
  assert.equal(direct.danger, true);
  assert.match(direct.message, /12/);
  assert.notEqual(direct.title, plain.title);
  assert.notEqual(direct.note, plain.note);
});

test("the build page builds its target, reports its facts and records the build", async () => {
  const platform = {
    id: "tw", name: "TW", targetClient: "D:\\tw\\jswz", cocosPath: "D:\\creator\\CocosCreator.exe", cocosVersion: "3.8.8",
    buildPlatform: "android", buildConfig: "", buildOutputName: "", buildDebug: false, buildMd5Cache: true, buildQaGuard: true,
  };
  const records = [];
  const workspace = {
    state: { build: { targetId: "tw" } },
    buildTarget: () => platform,
    updateBuildTarget: (id, patch) => Object.assign(platform, patch),
    platformById: () => platform,
    recordTool: (entry) => records.push(entry),
  };
  const backend = fakeBackend({
    lines: [{ stream: "out", line: "Build success" }],
    result: { outcome: "success", exitCode: 36, outputDir: "D:\\tw\\jswz\\build\\android", qa: null },
  });
  const tool = useCocosBuildTool({ workspace, backend, now: () => 5000 });
  await settle();
  assert.equal(tool.engineVersion.value, "3.8.8");
  assert.equal(tool.state.editors.length, 1);
  assert.equal(tool.outputDir.value, "D:\\tw\\jswz\\build\\android");
  assert.equal(tool.blocked.value, false);
  await tool.build();
  assert.equal(tool.state.status, "done");
  assert.deepEqual(tool.state.lines, [{ text: "Build success", tone: "" }]);
  assert.deepEqual([records[0].kind, records[0].outcome, records[0].platformId, records[0].demo, records[0].details.exitCode], ["build", "done", "tw", false, 36]);
  tool.update({ buildPlatform: "ios" });
  assert.equal(platform.buildPlatform, "ios");
  tool.dispose();
});

test("a missing editor is replaced by the single installed copy of that version", async () => {
  const platform = {
    id: "tw", name: "TW", targetClient: "D:\\missing\\jswz", cocosPath: "D:\\missing\\CocosCreator.exe", cocosVersion: "3.8.8",
    buildPlatform: "android", buildConfig: "", buildOutputName: "", buildDebug: false, buildMd5Cache: true, buildQaGuard: true,
  };
  const workspace = {
    state: { build: { targetId: "tw" } },
    buildTarget: () => platform,
    updateBuildTarget: (id, patch) => Object.assign(platform, patch),
    platformById: () => platform,
  };
  const backend = fakeBackend({ project: { exists: false, editorExists: false } });
  backend.findEditors = async () => [
    { version: "2.4.15", path: "D:\\creator_2.4.3\\CocosCreator.exe", source: "dashboard" },
    { version: "3.8.8", path: "D:\\client2\\creator3.8\\CocosCreator.exe", source: "dashboard" },
  ];
  const tool = useCocosBuildTool({ workspace, backend, now: () => 1 });
  await settle();
  await settle();
  assert.equal(platform.cocosPath, "D:\\client2\\creator3.8\\CocosCreator.exe");
  assert.equal(platform.cocosVersion, "3.8.8");
  tool.dispose();
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextTick } from "vue";
import { useReleaseWorkflow } from "./composables/useReleaseWorkflow.js";
import {
  RELEASE_ACTIONS, RELEASE_DRAFT_KEY, createReleaseDraft, createReleaseState,
  invalidateReleaseFrom, planPreview, releaseActionBlock, releaseArtifact,
  releaseConfigError, releaseFilePreview, releaseToday, restoreReleaseState, stepComplete,
  validReleaseDate,
} from "./releaseWorkflowState.js";

function harness(t, options = {}) {
  const values = new Map([[RELEASE_DRAFT_KEY, JSON.stringify(createReleaseState("2026-02-28"))]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const workflow = useReleaseWorkflow({ storage, delay: 0, now: () => new Date("2026-02-28T02:00:00Z"), ...options });
  t.after(workflow.dispose);
  return { ...workflow, storage };
}

async function completeThrough(workflow, last = "open") {
  workflow.updateConfig("prepared", true, 0);
  for (const action of Object.keys(RELEASE_ACTIONS)) {
    if (action === "activityReload" && !workflow.config.value.reloadActivity) continue;
    if (action === "dbApply") workflow.draft.value.checks.database = true;
    if (action === "diff") workflow.draft.value.checks.diff = true;
    if (action === "open") workflow.draft.value.checks.launch = true;
    if (workflow.draft.value.results[action] !== "done") assert.equal(await workflow.run(action), true, action);
    if (action === last) break;
  }
}

test("release dates use UTC+8 and generated plans work across short months", () => {
  assert.equal(releaseToday(new Date("2026-02-28T16:30:00Z")), "2026-03-01");
  assert.equal(validReleaseDate("2026-02-30"), false);
  assert.equal(validReleaseDate("2028-02-29"), true);
  assert.equal(validReleaseDate("2026-2-01"), false);
  for (const platform of ["b", "c", "d"]) {
    const draft = createReleaseDraft(platform, "2026-02-28");
    assert.ok(planPreview(draft.config).every((row) => row.valid));
  }
  assert.equal(createReleaseDraft("c", "2026-02-28").config.plans[0].start, "2026-03-07");
});

test("availability start and end are inclusive and freeform notes are never interpreted", () => {
  const config = createReleaseDraft("b", "2026-02-28").config;
  config.plans = [{ ...config.plans[0], start: "2026-02-28", end: "2026-02-28", current: 0, note: "close everything" }];
  assert.deepEqual(planPreview(config).map(({ next, changed, valid }) => ({ next, changed, valid })), [{ next: 1, changed: true, valid: true }]);
  config.date = "2026-03-01";
  assert.equal(planPreview(config)[0].next, 0);
  config.plans[0].end = "";
  assert.equal(planPreview(config)[0].next, 1);
  config.plans[0].end = "2026-02-27";
  assert.equal(planPreview(config)[0].valid, false);
});

test("config validation rejects ambiguous targets and bad schedules", () => {
  const config = createReleaseDraft("b", "2026-02-28").config;
  config.targetDb = " DEVELOPMENT_CFG ";
  assert.equal(releaseConfigError(config, 1), "sameDatabase");
  config.targetDb = "platform_cfg";
  config.plans.push({ ...config.plans[0], id: "duplicate" });
  assert.equal(releaseConfigError(config, 1), "planDuplicate");
  config.plans.pop();
  config.plans[0].field = " ";
  assert.equal(releaseConfigError(config, 1), "planInvalid");
  config.sourceClient = "C:\\game\\client";
  config.targetClient = "c:/game/client/platform";
  assert.equal(releaseConfigError(config, 2), "sameClient");
  config.maintenanceEnd = "2026-02-28T08:00";
  assert.equal(releaseConfigError(config, 4), "scheduleOrder");
  config.maintenanceEnd = "2026-02-28T10:00";
  config.clientOpen = "2026-02-28T09:59";
  assert.equal(releaseConfigError(config, 4), "clientTooEarly");
  assert.equal(releaseConfigError(config, 4, "clientUpload"), "");
  config.clientOpen = "2026-02-28T10:00";
  assert.equal(releaseConfigError(config, 4), "");
});

test("all six stages run in order and export explicitly simulated results", async (t) => {
  const workflow = harness(t);
  assert.equal(await workflow.run("open"), false);
  assert.equal(await workflow.run("preflight"), false);
  await completeThrough(workflow);
  assert.equal(workflow.complete.value, true);
  assert.equal(workflow.doneCount.value, 6);
  assert.equal(workflow.draft.value.results.activityReload, undefined);
  assert.equal(await workflow.run("open"), false);
  const report = JSON.parse(workflow.report());
  assert.equal(report.demo, true);
  assert.equal(report.realOperationsExecuted, false);
  assert.equal(report.timezone, "Asia/Shanghai");
  assert.equal(report.results.open, "done");
  assert.equal(report.logs.at(-1).action, "open");
});

test("database, diff and reopening require explicit review, and optional reload gates schedule", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow, "dbPreview");
  assert.equal(releaseActionBlock(workflow.draft.value, "dbApply"), "reviewDatabase");
  assert.equal(await workflow.run("dbApply"), false);
  await completeThrough(workflow, "transfer");
  assert.equal(releaseActionBlock(workflow.draft.value, "diff"), "reviewDiff");
  await completeThrough(workflow, "serverCurrent");
  workflow.updateConfig("reloadActivity", true, 4);
  assert.equal(releaseActionBlock(workflow.draft.value, "schedule"), "dependency");
  assert.equal(workflow.draft.value.results.activityCurrent, "done");
  await completeThrough(workflow, "health");
  assert.equal(releaseActionBlock(workflow.draft.value, "open"), "reviewLaunch");
});

test("SVN conflicts stop copy until both decisions are recorded, including after resume", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow, "dbApply");
  workflow.conflictDemo.value = true;
  assert.equal(await workflow.run("svn"), false);
  assert.equal(workflow.draft.value.results.svn, "blocked");
  assert.equal(await workflow.run("copy"), false);
  workflow.draft.value.conflicts.code = "local";
  assert.equal(releaseActionBlock(workflow.draft.value, "svn"), "resolveConflicts");
  const restored = restoreReleaseState(JSON.stringify(workflow.state));
  assert.equal(restored.drafts.b.results.svn, "blocked");
  assert.equal(releaseActionBlock(restored.drafts.b, "svn"), "resolveConflicts");
  workflow.draft.value.conflicts.config = "remote";
  assert.equal(await workflow.run("svn"), true);
  assert.equal(await workflow.run("copy"), true);
});

test("a simulated failed build blocks upload and can be retried", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow, "diff");
  workflow.buildFailureDemo.value = true;
  assert.equal(await workflow.run("build"), false);
  assert.equal(workflow.draft.value.results.build, "failed");
  assert.equal(await workflow.run("clientUpload"), false);
  assert.equal(await workflow.run("build"), true);
  assert.equal(await workflow.run("clientUpload"), true);
});

test("cancel prevents late completion and switching/resetting cannot pollute another platform", async (t) => {
  const workflow = harness(t, { delay: 5 });
  workflow.updateConfig("prepared", true, 0);
  const pending = workflow.run("preflight");
  workflow.switchPlatform("c");
  workflow.go(4);
  workflow.updateConfig("version", "ignored", 0);
  assert.equal(workflow.state.platform, "b");
  assert.equal(workflow.state.step, 0);
  assert.notEqual(workflow.config.value.version, "ignored");
  workflow.cancel();
  workflow.switchPlatform("c");
  workflow.reset();
  assert.equal(await pending, false);
  assert.deepEqual(workflow.draft.value.results, {});
  workflow.switchPlatform("b");
  assert.equal(workflow.draft.value.results.preflight, "cancelled");
  assert.equal(await workflow.run("preflight"), true);
});

test("platform drafts survive reload and editing upstream invalidates all dependent results", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow);
  workflow.switchPlatform("c");
  workflow.updateConfig("version", "c-custom", 0);
  workflow.switchPlatform("b");
  assert.equal(workflow.complete.value, true);
  workflow.updatePlan(workflow.config.value.plans[0].id, "start", "2026-03-01");
  assert.equal(workflow.draft.value.results.preflight, "done");
  assert.equal(workflow.draft.value.results.dbPreview, undefined);
  assert.equal(workflow.draft.value.results.open, undefined);
  assert.equal(workflow.draft.value.preview, null);
  assert.equal(workflow.draft.value.checks.database, false);
  assert.equal(workflow.draft.value.checks.diff, false);
  assert.equal(workflow.draft.value.checks.launch, false);
  assert.equal(workflow.invalidated.value, true);
  await nextTick();
  const restored = restoreReleaseState(workflow.storage.getItem(RELEASE_DRAFT_KEY));
  assert.equal(restored.drafts.c.config.version, "c-custom");
  assert.equal(restored.drafts.b.results.preflight, "done");
  assert.ok(restored.drafts.b.logs.length > 0);
});

test("schedule edits keep uploads; server changes keep activity and client uploads", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow);
  workflow.updateConfig("clientOpen", "2026-02-28T10:10", 4);
  assert.equal(workflow.draft.value.results.serverCurrent, "done");
  assert.equal(workflow.draft.value.results.clientUpload, "done");
  assert.equal(workflow.draft.value.results.schedule, undefined);
  assert.equal(workflow.draft.value.results.open, undefined);
  await completeThrough(workflow);
  workflow.updateConfig("serverPackage", "demo/server-next.zip", 4);
  assert.equal(workflow.draft.value.results.activityCurrent, "done");
  assert.equal(workflow.draft.value.results.clientUpload, "done");
  assert.equal(workflow.draft.value.results.serverUpload, undefined);
  assert.equal(workflow.draft.value.results.serverCurrent, undefined);
});

test("date changes move default schedule dates and reset all results", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow, "preflight");
  workflow.updateConfig("date", "2026-03-02", 0);
  assert.equal(workflow.config.value.maintenanceStart, "2026-03-02T09:00");
  assert.deepEqual(workflow.draft.value.results, {});
  assert.equal(workflow.config.value.plans[0].start, "2026-02-28");
});

test("restoration rejects corrupt storage, impossible successes and oversized plans", () => {
  assert.equal(restoreReleaseState("{bad", "2026-02-28").platform, "b");
  const state = createReleaseState("2026-02-28");
  state.step = 99;
  state.drafts.b.results = { preflight: "running", open: "done", unknown: "done" };
  state.drafts.b.preview = [{ forged: true }];
  state.drafts.b.config.plans = Array.from({ length: 101 }, () => ({ kind: "evil", table: null }));
  const draft = restoreReleaseState(state).drafts.b;
  assert.deepEqual(draft.results, { preflight: "cancelled" });
  assert.equal(draft.preview, null);
  assert.equal(draft.config.plans.length, 100);
  assert.equal(draft.config.plans[0].kind, "feature");
  assert.equal(restoreReleaseState(state).step, 5);
});

test("a completed release restores with a recomputed preview", async (t) => {
  const workflow = harness(t);
  await completeThrough(workflow);
  const restored = restoreReleaseState(JSON.stringify(workflow.state));
  assert.equal(stepComplete(restored.drafts.b, 5), true);
  assert.deepEqual(restored.drafts.b.preview, planPreview(restored.drafts.b.config));
  invalidateReleaseFrom(restored.drafts.b, 3);
  assert.equal(restored.drafts.b.results.diff, "done");
  assert.equal(restored.drafts.b.results.build, undefined);
});

test("storage failures remain session-only without preventing rehearsal", async (t) => {
  const workflow = harness(t, { storage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); } } });
  assert.equal(workflow.persistenceError.value, true);
  workflow.updateConfig("prepared", true, 0);
  assert.equal(await workflow.run("preflight"), true);
  await nextTick();
  assert.equal(workflow.persistenceError.value, true);
  assert.equal(JSON.parse(workflow.report()).results.preflight, "done");
});

test("sample file exclusions always protect SVN metadata without swallowing sibling paths", () => {
  let files = releaseFilePreview("settings/platform.json\nassets/props/");
  assert.equal(files.find((file) => file.path === ".svn/wc.db").excluded, true);
  assert.equal(files.find((file) => file.path === "assets/props/hero.json").excluded, true);
  assert.equal(files[0].excluded, false);
  files = releaseFilePreview("assets/prop");
  assert.equal(files.find((file) => file.path === "assets/props/hero.json").excluded, false);
  assert.equal(releaseArtifact({ version: "v1/../../2" }, "b"), "client_b_v1_.._.._2.zip");
});

test("demo state, controller and stage components never call execution bridges", async () => {
  const files = ["releaseWorkflowState.js", "composables/useReleaseWorkflow.js",
    ...["Prepare", "Database", "Client", "Build", "Gm", "Launch"].map((stage) => `components/Release${stage}Stage.vue`)];
  for (const path of files) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:fetch|invokeWorkbench|invoke|exec|spawn|XMLHttpRequest)\s*\(/, path);
    assert.doesNotMatch(source, /(?:@tauri|node:fs|node:child_process)/, path);
  }
});

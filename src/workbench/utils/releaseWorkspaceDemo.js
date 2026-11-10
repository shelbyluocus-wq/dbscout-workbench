// Seeds that make the demo workspace look lived-in on its first open: a few
// past updates and a client build in the history, and one update scheduled
// for later this week. Every seeded entry is marked as demo, like the
// simulated updates themselves; the demo options can clear them.

import { TASK_STATUS, applicableTasks, createReleaseBrief } from "../releaseFlowState.js";
import { createRun } from "../releaseWorkspaceState.js";
import { addDays } from "./releasePlanNotes.js";
import { DEMO_BUILD_OUTPUT, DEMO_COCOS_VERSION, DEMO_REVISION } from "./releaseFlowDemo.js";

const ALL_SCOPES = Object.freeze({ database: true, client: true });

// Files a sync of the TAP client could not find in the development client.
const DEMO_MISSING_FILES = Object.freeze([
  "assets/bundles/activity/P5/npc_1034.png.meta",
  "assets/bundles/sacSpirit/prefab/sacSpiritArtifactUI.prefab",
]);

const HISTORY_SEEDS = Object.freeze([
  { platformId: "tw", daysAgo: 13, scope: ALL_SCOPES, start: "10:00", minutes: 150 },
  {
    platformId: "tap",
    daysAgo: 6,
    scope: ALL_SCOPES,
    start: "14:00",
    minutes: 95,
    warnings: DEMO_MISSING_FILES,
  },
  { platformId: "douyin", daysAgo: 2, scope: ALL_SCOPES, start: "10:00", minutes: 140 },
]);

function seededRelease(seed, { today, platforms }) {
  const date = addDays(today, -seed.daysAgo);
  const startedAt = new Date(`${date}T${seed.start}`).getTime();
  const finishedAt = startedAt + seed.minutes * 60000;
  const brief = { ...createReleaseBrief(date), scope: { ...seed.scope }, prepared: true, started: true };
  const definitions = applicableTasks(brief);
  const span = (finishedAt - startedAt) / definitions.length;
  const platform = platforms.find((entry) => entry.id === seed.platformId);
  const steps = definitions.map((definition, index) => ({
    taskId: definition.id,
    status: TASK_STATUS.DONE,
    startedAt: Math.round(startedAt + span * index),
    finishedAt: Math.round(startedAt + span * (index + 1)),
    result: definition.id === "client.sync" && seed.warnings
      ? { added: 2, modified: 11, deleted: 2, excluded: 7, warnings: seed.warnings.map((path) => ({ code: "missing", path })) }
      : definition.id === "client.svn" ? { revision: DEMO_REVISION - seed.daysAgo * 9, conflicts: [], resolved: 0 } : null,
    error: "",
    logs: [],
  }));
  return {
    id: `history-demo-${seed.platformId}-${date}`,
    kind: "release",
    runId: "",
    platformId: seed.platformId,
    platformName: platform?.name || seed.platformId,
    demo: true,
    outcome: "done",
    createdAt: startedAt - 30 * 60000,
    startedAt,
    finishedAt,
    brief: { date, scope: { ...seed.scope } },
    steps,
    events: [],
    logs: [],
    stats: { done: steps.length, total: steps.length, failed: 0, warnings: seed.warnings?.length || 0 },
  };
}

function seededBuild({ today, platforms }) {
  const platform = platforms.find((entry) => entry.id === "douyin");
  const date = addDays(today, -1);
  const startedAt = new Date(`${date}T16:20`).getTime();
  const finishedAt = startedAt + 9 * 60000;
  return {
    id: `history-demo-build-douyin-${date}`,
    kind: "build",
    runId: "",
    platformId: "douyin",
    platformName: platform?.name || "douyin",
    demo: true,
    outcome: "done",
    createdAt: startedAt,
    startedAt,
    finishedAt,
    title: "",
    details: {
      project: platform?.targetClient || "",
      engineVersion: DEMO_COCOS_VERSION,
      editorVersion: DEMO_COCOS_VERSION,
      platform: "android",
      outputDir: `${platform?.targetClient || ""}\\${DEMO_BUILD_OUTPUT}`,
      exitCode: 36,
      qa: { checked: 1286, findings: 0 },
    },
    steps: [],
    events: [],
    logs: [],
    stats: { done: 0, total: 0, failed: 0, warnings: 0 },
  };
}

export function createDemoHistory({ today, platforms }) {
  return [...HISTORY_SEEDS.map((seed) => seededRelease(seed, { today, platforms })), seededBuild({ today, platforms })];
}

export function createDemoRuns({ today }) {
  const date = addDays(today, 2);
  const run = createRun({ id: "run-demo-wanxin", platformId: "wanxin", today: date, createdAt: new Date(`${today}T09:00`).getTime() });
  return [run];
}

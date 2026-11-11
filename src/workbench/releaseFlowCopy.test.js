import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import en from "./i18n/en.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";
import { releaseFlowEn } from "./i18n/releaseFlowMessages.js";
import { RELEASE_PAGES, RELEASE_PHASES, RELEASE_SCOPES, RELEASE_TASKS } from "./releaseFlowState.js";
import { CONFLICT_CHOICES, RELEASE_SPEEDS } from "./composables/useReleaseFlow.js";
import { HISTORY_KINDS, HISTORY_OUTCOMES } from "./releaseWorkspaceState.js";
import { AUTOPILOT_GROUPS, AUTOPILOT_LOG_KINDS, AUTOPILOT_RULES } from "./releaseAutopilotState.js";
import { PLAN_MEMO_CATEGORIES } from "./utils/releaseFlowDemo.js";

const root = new URL("./", import.meta.url);
const SOURCES = [
  "MySqlWorkbench.vue",
  ...readdirSync(new URL("components/", root)).filter((name) => name.startsWith("Release")).map((name) => `components/${name}`),
  "composables/useReleaseFlow.js",
  "composables/useReleaseRealDriver.js",
  "composables/useReleaseWorkspace.js",
  "composables/useCocosBuild.js",
  "composables/useSvnWorkspace.js",
  "composables/useActivityRail.js",
  "utils/releaseFlowFormat.js",
  "utils/releaseHistoryFormat.js",
  "utils/releaseFlowDemo.js",
  "utils/releasePlanCandidates.js",
  "utils/releasePlatformFields.js",
];

// Keys the workspace builds at run time from its own vocabularies.
function dynamicKeys() {
  const keys = [];
  const add = (prefix, values, suffixes = [""]) => {
    for (const value of values) for (const suffix of suffixes) keys.push(`releaseFlow.${prefix}${value}${suffix}`);
  };
  const pages = RELEASE_PAGES.map((entry) => entry.id);
  add("page.", pages, [".title"]);
  add("page.", pages.filter((id) => id !== "summary"), [".description"]);
  add("task.", RELEASE_TASKS.map((entry) => entry.id), [".title"]);
  add("task.", RELEASE_TASKS.filter((entry) => entry.id !== "db.plans" && !entry.action).map((entry) => entry.id), [".run"]);
  add("task.", RELEASE_TASKS.filter((entry) => entry.skippable).map((entry) => entry.id), [".skipHint"]);
  add("phase.", RELEASE_PHASES);
  add("scope.", RELEASE_SCOPES);
  add("rail.state.", ["done", "skipped", "running", "failed", "attention", "pending", "notApplicable"]);
  add("demo.speed.", Object.keys(RELEASE_SPEEDS));
  add("plan.category.", PLAN_MEMO_CATEGORIES);
  add("svn.choice.", CONFLICT_CHOICES);
  add("files.filter.", ["copy", "excluded"]);
  add("files.status.", ["A", "M", "D"]);
  add("transfer.stage.", ["script", "locate", "copy"]);
  add("cocos.exit.", ["success", "invalidOptions", "buildError", "unknown"]);
  add("platformEditor.", ["sourceDatabase", "targetDatabase", "sourceClient", "targetClient", "cocosVersion", "buildPlatform", "cocosPath"]);
  add("platformEditor.group.", ["database", "client", "build"]);
  add("error.", [
    "interrupted",
    "buildFailed",
    "failed",
    "unknownTask",
    "qaFindings",
    "noBackup",
    "missingConnection",
    "invalidSyncDatabases",
    "missingClientPath",
    "missingTemplate",
    "svnConflictsRemain",
  ]);
  // One-click mode: its rules and choices, why it pauses, its log.
  add("autopilot.rule.", AUTOPILOT_RULES.map((rule) => rule.id));
  for (const rule of AUTOPILOT_RULES) add(`autopilot.choice.${rule.id}.`, rule.choices);
  add("autopilot.group.", [...AUTOPILOT_GROUPS, "failures"]);
  add("autopilot.status.", ["running", "paused", "done"]);
  add("autopilot.reason.", ["notReady", "conflicts", "missingFiles", "failed", "blocked", "review", "planNotes", "stopped"]);
  add("autopilot.log.", AUTOPILOT_LOG_KINDS);
  // The workspace around the updates: navigation, cards, history and tools.
  add("nav.", ["home", "history", "plans", "build", "svn", "platforms"]);
  add("card.status.", ["idle", "pending", "active", "attention", "done"]);
  add("history.outcome.", HISTORY_OUTCOMES);
  add("history.kind.", HISTORY_KINDS);
  add("history.step.", ["idle", "attention", "running"]);
  add("history.title.", ["revert", "resolve"]);
  add("home.action.", ["new", "build", "svn", "plans"], ["", ".hint"]);
  add("home.plan.", ["open", "close"]);
  add("build.problem.", ["noProject", "projectMissing", "notCocosProject", "noEditor", "editorMissing", "noPlatform", "familyMismatch", "versionMismatch", "configMissing", "nativeWithoutConfig"]);
  add("build.qa.", ["findings", "failed", "nodeMissing", "missing"]);
  add("build.hint.", ["sdk", "ndk", "jdk"]);
  add("build.source.", ["nearby", "dashboard"]);
  add("files.pick.added.", ["file", "folder"]);
  add("files.pick.", ["outside", "isRoot", "rootMissing", "missing"]);
  add("files.kind.", ["file", "folder", "pattern"]);
  add("svn.item.", ["modified", "added", "deleted", "replaced", "unversioned", "missing", "conflicted", "obstructed", "incomplete", "normal"]);
  add("svn.group.", ["conflicts", "changes", "unversioned"]);
  add("svn.accept.", ["theirs-full", "mine-full", "working"]);
  add("svn.resolve.message.", ["theirs-full", "mine-full", "working"]);
  add("svn.done.", ["revert", "resolve"]);
  add("svn.error.", ["notWorkingCopy", "outOfDate", "locked", "auth", "network", "conflict", "svnMissing", "failed"]);
  add("diff.property.", ["Added", "Deleted", "Modified"]);
  add("transfer.nameError.", ["invalid", "duplicate", "busy"]);
  add("transfer.strategy.", ["theirs", "mine", "manual"]);
  return keys;
}

function staticKeys() {
  const keys = new Set();
  for (const file of SOURCES) {
    const source = readFileSync(new URL(file, root), "utf8");
    for (const match of source.matchAll(/["'`](releaseFlow\.[A-Za-z0-9_.-]+)["'`]/g)) keys.add(match[1]);
  }
  return keys;
}

test("every release workspace message exists in all three languages", () => {
  for (const key of [...staticKeys(), ...dynamicKeys()]) {
    for (const [name, catalog] of [["en", en], ["zh-CN", zhCN], ["zh-TW", zhTW]]) {
      assert.equal(typeof catalog[key], "string", `${name}: ${key}`);
    }
  }
});

test("every release workspace message is used", () => {
  const used = new Set([...staticKeys(), ...dynamicKeys()]);
  // "<key>.macos" variants are resolved by tPlatform at runtime from the base
  // key's call site, so they count as used whenever the base key is.
  const isUsed = (key) => used.has(key) || used.has(key.replace(/\.macos$/, ""));
  assert.deepEqual(Object.keys(releaseFlowEn).filter((key) => !isUsed(key)), []);
});

test("Taiwan copy uses the workbench's Taiwan terminology", () => {
  const taiwan = Object.entries(zhTW).filter(([key]) => key.startsWith("releaseFlow."));
  for (const [key, value] of taiwan) {
    assert.doesNotMatch(value, /数据库|服务器|文件夹|设置|信息|默认|脚本/, key);
  }
  assert.equal(zhTW["releaseFlow.title"], "版本更新");
  assert.equal(zhTW["releaseFlow.phase.database"], "覆蓋資料庫");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import en from "./i18n/en.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";
import { releaseFlowEn } from "./i18n/releaseFlowMessages.js";
import { RELEASE_MODES, RELEASE_PAGES, RELEASE_PHASES, RELEASE_SCOPES, RELEASE_TASKS, TASK_STATUS } from "./releaseFlowState.js";
import { CONFLICT_CHOICES, RELEASE_SPEEDS } from "./composables/useReleaseFlow.js";
import { DEMO_PLATFORM_IDS, RELEASE_PLAN_CATEGORIES } from "./utils/releaseFlowDemo.js";

const root = new URL("./", import.meta.url);
const SOURCES = [
  ...readdirSync(new URL("components/", root)).filter((name) => name.startsWith("Release")).map((name) => `components/${name}`),
  "composables/useReleaseFlow.js",
  "composables/useActivityRail.js",
  "utils/releaseFlowFormat.js",
  "utils/releaseFlowDemo.js",
];

// Keys the workspace builds at run time from its own vocabularies.
function dynamicKeys() {
  const keys = [];
  const add = (prefix, values, suffixes = [""]) => {
    for (const value of values) for (const suffix of suffixes) keys.push(`releaseFlow.${prefix}${value}${suffix}`);
  };
  add("page.", RELEASE_PAGES.map((entry) => entry.id), [".title"]);
  add("page.", RELEASE_PAGES.filter((entry) => entry.id !== "summary").map((entry) => entry.id), [".description"]);
  add("task.", RELEASE_TASKS.map((entry) => entry.id), [".title"]);
  add("task.", RELEASE_TASKS.filter((entry) => entry.id !== "db.plans").map((entry) => entry.id), [".run"]);
  add("task.", RELEASE_TASKS.filter((entry) => entry.skippable).map((entry) => entry.id), [".skipHint"]);
  add("task.", RELEASE_TASKS.filter((entry) => entry.id.startsWith("gm.")).map((entry) => entry.id), [".hint", ".done"]);
  add("phase.", RELEASE_PHASES);
  add("mode.", RELEASE_MODES);
  add("overview.modeHint.", RELEASE_MODES);
  add("scope.", RELEASE_SCOPES, ["", ".hint"]);
  add("rail.state.", ["done", "skipped", "running", "failed", "attention", "pending", "notApplicable"]);
  add("demo.speed.", Object.keys(RELEASE_SPEEDS));
  add("demo.platform.", DEMO_PLATFORM_IDS);
  add("plan.category.", RELEASE_PLAN_CATEGORIES.map((entry) => entry.id));
  add("plan.rule.", ["open", "closed", "always", "never", "empty", "unknown"]);
  add("plan.verdict.", ["open", "always", "opensToday", "ended", "never", "closed", "unknown", "empty"]);
  add("plan.write.", ["open", "close"]);
  add("svn.choice.", CONFLICT_CHOICES);
  add("files.filter.", ["all", "copy", "excluded"]);
  add("files.status.", ["A", "M", "D"]);
  add("transfer.stage.", ["script", "locate", "copy"], ["", ".hint"]);
  add("cocos.exit.", ["success", "invalidOptions", "buildError", "unknown"]);
  add("gm.group.", ["activity", "client", "server", "launch"]);
  add("schedule.problem.", ["endBeforeStart", "clientBeforeEnd"]);
  add("summary.event.", [TASK_STATUS.DONE, TASK_STATUS.ATTENTION, TASK_STATUS.FAILED, TASK_STATUS.SKIPPED]);
  add("platformEditor.", ["name", "sourceDatabase", "targetDatabase", "sourceClient", "targetClient", "cocosVersion", "cocosPath", "buildPlatform", "buildConfig"]);
  add("error.", ["interrupted", "buildFailed", "failed", "unknownTask"]);
  return keys;
}

function staticKeys() {
  const keys = new Set();
  for (const file of SOURCES) {
    const source = readFileSync(new URL(file, root), "utf8");
    for (const match of source.matchAll(/["'`](releaseFlow\.[A-Za-z0-9_.]+)["'`]/g)) keys.add(match[1]);
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
  assert.deepEqual(Object.keys(releaseFlowEn).filter((key) => !used.has(key)), []);
});

test("Taiwan copy uses the workbench's Taiwan terminology", () => {
  const taiwan = Object.entries(zhTW).filter(([key]) => key.startsWith("releaseFlow."));
  for (const [key, value] of taiwan) {
    assert.doesNotMatch(value, /数据库|服务器|文件夹|设置|信息|默认|脚本/, key);
  }
  assert.equal(zhTW["releaseFlow.title"], "版本更新");
  assert.equal(zhTW["releaseFlow.phase.database"], "覆蓋資料庫");
});

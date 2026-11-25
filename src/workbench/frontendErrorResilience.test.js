import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildFrontendErrorPayload,
  installGlobalErrorHandlers,
  isRenderOrPatchError,
  redactFrontendErrorText,
  reportFrontendError,
  resetFrontendErrorThrottleForTests,
} from "./utils/frontendErrorLog.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";
import en from "./i18n/en.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, rel), "utf8");

test("redactFrontendErrorText strips database URL passwords and bearer tokens", () => {
  const input =
    "Failed mysql://root:superSecret99@192.168.1.243:8306/newsg_4cfg and mongodb+srv://admin:p@ss@cluster.local/db with Authorization: Bearer eyJhbGciOi.payload.sig";
  const redacted = redactFrontendErrorText(input);
  assert.doesNotMatch(redacted, /superSecret99/);
  assert.doesNotMatch(redacted, /eyJhbGciOi/);
  assert.match(redacted, /mysql:\/\/\*\*\*@192\.168\.1\.243:8306\/newsg_4cfg/);
  assert.match(redacted, /Bearer \*\*\*/);
});

test("buildFrontendErrorPayload normalizes Error and clips long stacks", () => {
  const err = new TypeError("Cannot read properties of null (reading 'insertBefore')");
  err.stack = "Error: boom\n" + "  at fn (index.js:1:1)\n".repeat(700);
  const payload = buildFrontendErrorPayload(err, {
    kind: "vue-error",
    component: "WorkbenchPane",
    info: "render",
    area: "pane",
  });
  assert.equal(payload.kind, "vue-error");
  assert.equal(payload.component, "WorkbenchPane");
  assert.equal(payload.area, "pane");
  assert.ok(payload.stack.endsWith("...[truncated]"));
  assert.ok(payload.stack.length <= 10_050);
});

test("reportFrontendError deduplicates identical errors within window and swallows transport errors", () => {
  resetFrontendErrorThrottleForTests();
  const sent = [];
  let clock = 10_000;
  const transport = (entry) => {
    sent.push(entry);
    return Promise.reject(new Error("transport offline"));
  };

  assert.equal(reportFrontendError(new Error("boom"), { kind: "vue-error", area: "pane" }, { transport, now: () => clock }), true);
  assert.equal(reportFrontendError(new Error("boom"), { kind: "vue-error", area: "pane" }, { transport, now: () => clock + 1000 }), false);
  assert.equal(sent.length, 1);

  clock += 6000;
  assert.equal(reportFrontendError(new Error("boom"), { kind: "vue-error", area: "pane" }, { transport, now: () => clock }), true);
  assert.equal(sent.length, 2);
});

test("isRenderOrPatchError identifies Vue render/scheduler errors and DOM patch failures", () => {
  assert.equal(isRenderOrPatchError(new Error("x"), "render function"), true);
  assert.equal(isRenderOrPatchError(new Error("x"), "https://vuejs.org/error-reference/#runtime-15"), true);
  assert.equal(isRenderOrPatchError(new TypeError("null is not an object (evaluating 'parent.insertBefore')"), ""), true);
  assert.equal(isRenderOrPatchError(new Error("network timeout"), "native event handler"), false);
});

test("installGlobalErrorHandlers reports Vue errors and ignores ResizeObserver loop noise", () => {
  resetFrontendErrorThrottleForTests();
  const reported = [];
  const listeners = new Map();
  const fakeWin = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
  };
  const fakeApp = { config: {} };
  const origConsoleError = console.error;
  console.error = () => {};
  try {
    installGlobalErrorHandlers(fakeApp, {
      win: fakeWin,
      transport: (entry) => reported.push(entry),
    });

    fakeApp.config.errorHandler(new Error("render boom"), { $options: { __name: "DatabaseHome" } }, "render");
    assert.equal(reported.length, 1);
    assert.equal(reported[0].kind, "vue-error");
    assert.equal(reported[0].component, "DatabaseHome");

    listeners.get("error")({ message: "ResizeObserver loop completed with undelivered notifications." });
    assert.equal(reported.length, 1);

    listeners.get("unhandledrejection")({ reason: new Error("async failure") });
    assert.equal(reported.length, 2);
    assert.equal(reported[1].kind, "unhandled-rejection");
  } finally {
    console.error = origConsoleError;
  }
});

test("MySqlWorkbench declares isFolderWindow before tableHistoryContext provide and wraps critical panels in error boundaries", () => {
  const workbench = read("./MySqlWorkbench.vue");
  const isFolderIdx = workbench.indexOf("const isFolderWindow =");
  const provideIdx = workbench.indexOf('provide("tableHistoryContext"');
  assert.ok(isFolderIdx > 0, "isFolderWindow declaration must exist");
  assert.ok(provideIdx > isFolderIdx, "provide('tableHistoryContext') must come after isFolderWindow declaration");
  assert.match(workbench, /<WorkbenchErrorBoundary\b[^>]*area="sidebar"/);
  assert.match(workbench, /<WorkbenchErrorBoundary\b[^>]*area="workspace"/);

  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  assert.match(splitLayout, /<WorkbenchErrorBoundary\b[^>]*:area="`pane:\$\{layout\.paneId\}`"/);

  const mainJs = read("../main.js");
  assert.match(mainJs, /installGlobalErrorHandlers\(app\)/);
});

test("WorkbenchPane hides DataGrid and CellDetailPanel via CSS class instead of v-show on components", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const dataGridTag = pane.match(/<DataGrid\b[\s\S]*?\/>/)?.[0] || "";
  const detailTag = pane.match(/<CellDetailPanel\b[\s\S]*?\/>/)?.[0] || "";
  assert.ok(dataGridTag, "DataGrid tag must exist");
  assert.ok(detailTag, "CellDetailPanel tag must exist");
  assert.doesNotMatch(dataGridTag, /\bv-show=/);
  assert.doesNotMatch(detailTag, /\bv-show=/);
  assert.match(dataGridTag, /wb-pane-view-hidden/);
  assert.match(detailTag, /wb-pane-view-hidden/);
});

test("errorBoundary i18n keys exist in all three locales", () => {
  const keys = [
    "errorBoundary.title",
    "errorBoundary.description",
    "errorBoundary.recover",
    "errorBoundary.reloadWindow",
    "errorBoundary.rootTitle",
    "errorBoundary.rootHint",
    "errorBoundary.dismiss",
  ];
  for (const key of keys) {
    assert.ok(zhCN[key], `zhCN missing ${key}`);
    assert.ok(zhTW[key], `zhTW missing ${key}`);
    assert.ok(en[key], `en missing ${key}`);
  }
});

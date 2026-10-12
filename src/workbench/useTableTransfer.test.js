import test from "node:test";
import assert from "node:assert/strict";

import {
  TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY,
  TABLE_TRANSFER_TEMPLATE_NAME_MAX_LENGTH,
  TABLE_TRANSFER_TEMPLATES_KEY,
  projectFolderToReveal,
  summarizeTransferError,
  useTableTransfer,
} from "./composables/useTableTransfer.js";

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
  };
}

function createEventBus() {
  const listeners = [];
  return {
    listeners,
    listen(eventName, handler) {
      listeners.push({ eventName, handler });
      return () => {
        const index = listeners.findIndex((item) => item.handler === handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(payload) {
      for (const listener of listeners) listener.handler({ payload });
    },
  };
}

test("templates fall back to the two presets when storage is empty or broken", () => {
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage: createStorage() });
  assert.equal(transfer.templates.value.length, 2);
  assert.equal(transfer.templates.value[0].name, "决胜1");
  assert.equal(transfer.templates.value[1].name, "决胜2");
  assert.equal(transfer.templates.value[0].conflictStrategy, "theirs");

  const broken = createStorage({ [TABLE_TRANSFER_TEMPLATES_KEY]: "not-json{" });
  const recovered = useTableTransfer({ invokeWorkbench: async () => ({}), storage: broken });
  assert.equal(recovered.templates.value.length, 2);
});

test("stored template fields override presets but names stay fixed", () => {
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", name: "被篡改的名字", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg", conflictStrategy: "mine" },
      { id: "unknown", scriptPath: "D:\\x.bat" },
    ]),
  });
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage });
  const first = transfer.templates.value[0];
  assert.equal(first.name, "决胜1");
  assert.equal(first.scriptPath, "D:\\tool\\gen.bat");
  assert.equal(first.conflictStrategy, "mine");
  assert.equal(first.builtIn, true);
  // An unknown entry without a name is not a user template and is ignored.
  assert.equal(transfer.templates.value.length, 2);
});

test("updateTemplate sanitizes values and persists to storage", () => {
  const storage = createStorage();
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage });
  transfer.updateTemplate("juesheng-2", { scriptPath: "  D:\\tool\\gen.lnk ", conflictStrategy: "bogus" });

  const second = transfer.templates.value[1];
  assert.equal(second.scriptPath, "D:\\tool\\gen.lnk");
  assert.equal(second.conflictStrategy, "theirs");

  const persisted = JSON.parse(storage.store[TABLE_TRANSFER_TEMPLATES_KEY]);
  assert.equal(persisted[1].scriptPath, "D:\\tool\\gen.lnk");
});

test("conflict strategy keeps mine and manual, and rejects unknown values", () => {
  const storage = createStorage();
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage });
  transfer.updateTemplate("juesheng-1", { conflictStrategy: "manual" });
  assert.equal(transfer.templates.value[0].conflictStrategy, "manual");
  transfer.updateTemplate("juesheng-1", { conflictStrategy: "mine" });
  assert.equal(transfer.templates.value[0].conflictStrategy, "mine");
  transfer.updateTemplate("juesheng-1", { conflictStrategy: "nope" });
  assert.equal(transfer.templates.value[0].conflictStrategy, "theirs");
});

test("discoverAndFill fills missing paths and keeps valid custom ones", async () => {
  const calls = [];
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "", projectRoot: "D:\\Versions\\nzg" },
      { id: "juesheng-2", scriptPath: "E:\\custom\\gen.bat", projectRoot: "" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    invokeWorkbench: async (command, payload) => {
      calls.push([command, payload]);
      if (command === "table_transfer_discover_paths") {
        return [
          { id: "juesheng-1", scriptPath: "D:\\Versions\\tools\\生成配置\\1-生成全部配置-客户端\\1.生成全部配置.bat", projectRoot: "D:\\Versions\\nzg" },
          { id: "juesheng-2", scriptPath: "E:\\custom\\gen.bat", projectRoot: "E:\\client\\jswz" },
        ];
      }
      return null;
    },
  });

  await transfer.discoverAndFill();
  assert.equal(calls[0][0], "table_transfer_discover_paths");
  assert.equal(transfer.templates.value[0].scriptPath, "D:\\Versions\\tools\\生成配置\\1-生成全部配置-客户端\\1.生成全部配置.bat");
  assert.equal(transfer.templates.value[0].projectRoot, "D:\\Versions\\nzg");
  assert.equal(transfer.templates.value[1].scriptPath, "E:\\custom\\gen.bat");
  assert.equal(transfer.templates.value[1].projectRoot, "E:\\client\\jswz");
});

test("open discovers paths but does not start transfer", async () => {
  const calls = [];
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    invokeWorkbench: async (command, payload) => {
      calls.push(command);
      if (command === "table_transfer_discover_paths") return payload.templates;
      if (command === "table_transfer_run") return { outputDir: "x", updatedDirs: [], copiedFiles: 0 };
      return null;
    },
  });

  transfer.open();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.includes("table_transfer_discover_paths"));
  assert.ok(!calls.includes("table_transfer_run"));
  assert.equal(transfer.dialog.status, "idle");
});

test("projectFolderToReveal always opens the assets layer", () => {
  assert.equal(projectFolderToReveal("D:\\client\\jswz"), "D:\\client\\jswz\\assets");
  assert.equal(projectFolderToReveal("D:\\client\\jswz\\assets"), "D:\\client\\jswz\\assets");
  assert.equal(projectFolderToReveal("D:\\client\\jswz\\Assets\\"), "D:\\client\\jswz\\Assets");
  assert.equal(projectFolderToReveal("D:\\Versions\\nzg/assets"), "D:\\Versions\\nzg/assets");
});

test("revealPath opens the configured script or project in the file manager", async () => {
  const calls = [];
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    invokeWorkbench: async (command, payload) => {
      calls.push([command, payload]);
      return true;
    },
  });

  assert.equal(await transfer.revealPath(""), false);
  assert.equal(await transfer.revealPath("   "), false);
  assert.equal(await transfer.revealPath("D:\\tool\\gen.bat"), true);
  assert.deepEqual(calls, [["reveal_local_path", { path: "D:\\tool\\gen.bat" }]]);
});

test("setActiveTemplate persists and rejects unknown ids", () => {
  const storage = createStorage();
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage });
  assert.equal(transfer.activeTemplateId.value, "juesheng-1");

  transfer.setActiveTemplate("juesheng-2");
  assert.equal(transfer.activeTemplateId.value, "juesheng-2");
  assert.equal(storage.store[TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY], "juesheng-2");

  transfer.setActiveTemplate("nope");
  assert.equal(transfer.activeTemplateId.value, "juesheng-2");
});

test("user templates are added with their own name and survive a reload", () => {
  const storage = createStorage();
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage });

  const created = transfer.addTemplate("  决胜2-分支  ");
  assert.equal(created.status, "created");
  assert.equal(created.template.name, "决胜2-分支");
  assert.equal(created.template.builtIn, false);
  assert.equal(created.template.conflictStrategy, "theirs");
  assert.equal(transfer.activeTemplateId.value, created.template.id);
  transfer.updateTemplate(created.template.id, {
    scriptPath: "E:\\branch\\gen.bat",
    projectRoot: "E:\\branch\\jswz",
    conflictStrategy: "mine",
  });

  const persisted = JSON.parse(storage.store[TABLE_TRANSFER_TEMPLATES_KEY]);
  assert.ok(persisted.every((entry) => !Object.hasOwn(entry, "builtIn")), "built-in flag is derived, not stored");

  const reloaded = useTableTransfer({ invokeWorkbench: async () => ({}), storage });
  assert.deepEqual(reloaded.templates.value.map((template) => template.name), ["决胜1", "决胜2", "决胜2-分支"]);
  assert.deepEqual(reloaded.activeTemplate.value, {
    id: created.template.id,
    name: "决胜2-分支",
    builtIn: false,
    scriptPath: "E:\\branch\\gen.bat",
    projectRoot: "E:\\branch\\jswz",
    conflictStrategy: "mine",
  });
});

test("template names must be non-empty, unique and short", () => {
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage: createStorage() });
  assert.equal(transfer.addTemplate("   ").status, "invalid");
  assert.equal(transfer.addTemplate(" 决胜1 ").status, "duplicate");
  assert.equal(transfer.templates.value.length, 2);

  const { template } = transfer.addTemplate("分支");
  assert.equal(transfer.validateTemplateName("分支"), "duplicate");
  assert.equal(transfer.validateTemplateName("分支", template.id), "");
  assert.equal(transfer.renameTemplate(template.id, "决胜2").status, "duplicate");
  assert.equal(transfer.renameTemplate(template.id, "  ").status, "invalid");
  assert.equal(transfer.renameTemplate(template.id, " 分支 ").status, "unchanged");
  assert.equal(transfer.renameTemplate(template.id, " 主干 ").status, "renamed");
  assert.equal(transfer.templates.value[2].name, "主干");

  const capped = transfer.addTemplate("长".repeat(60)).template;
  assert.equal(capped.name, "长".repeat(TABLE_TRANSFER_TEMPLATE_NAME_MAX_LENGTH));
});

test("suggestTemplateName numbers repeated default names", () => {
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage: createStorage() });
  assert.equal(transfer.suggestTemplateName("新模板"), "新模板");
  transfer.addTemplate(transfer.suggestTemplateName("新模板"));
  assert.equal(transfer.suggestTemplateName("新模板"), "新模板 2");
  transfer.addTemplate(transfer.suggestTemplateName("新模板"));
  assert.equal(transfer.suggestTemplateName("新模板"), "新模板 3");
});

test("built-in templates keep their name and cannot be deleted", () => {
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage: createStorage() });
  assert.equal(transfer.renameTemplate("juesheng-1", "我的决胜").status, "builtIn");
  assert.equal(transfer.renameTemplate("missing", "x").status, "missing");
  assert.equal(transfer.deleteTemplate("juesheng-1"), false);
  assert.equal(transfer.deleteTemplate("missing"), false);

  // updateTemplate only edits paths and strategy, never identity or name.
  transfer.updateTemplate("juesheng-2", { id: "custom-x", name: "篡改", scriptPath: "D:\\gen.bat" });
  assert.deepEqual(
    transfer.templates.value.map((template) => [template.id, template.name, template.builtIn]),
    [["juesheng-1", "决胜1", true], ["juesheng-2", "决胜2", true]],
  );
  assert.equal(transfer.templates.value[1].scriptPath, "D:\\gen.bat");
});

test("deleting the active user template selects its neighbour and persists", () => {
  const storage = createStorage();
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage });
  const first = transfer.addTemplate("A").template;
  const second = transfer.addTemplate("B").template;
  const third = transfer.addTemplate("C").template;

  transfer.setActiveTemplate(second.id);
  assert.equal(transfer.deleteTemplate(second.id), true);
  assert.equal(transfer.activeTemplateId.value, third.id, "the right neighbour takes over");

  assert.equal(transfer.deleteTemplate(third.id), true);
  assert.equal(transfer.activeTemplateId.value, first.id, "the left neighbour takes over at the end");

  transfer.setActiveTemplate("juesheng-2");
  assert.equal(transfer.deleteTemplate(first.id), true);
  assert.equal(transfer.activeTemplateId.value, "juesheng-2", "deleting another template keeps the selection");

  const persisted = JSON.parse(storage.store[TABLE_TRANSFER_TEMPLATES_KEY]);
  assert.deepEqual(persisted.map((entry) => entry.id), ["juesheng-1", "juesheng-2"]);
  assert.equal(storage.store[TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY], "juesheng-2");

  const stale = createStorage({ [TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY]: first.id });
  assert.equal(useTableTransfer({ invokeWorkbench: async () => ({}), storage: stale }).activeTemplateId.value, "juesheng-1");
});

test("discovery only asks about built-in templates and leaves user templates alone", async () => {
  const calls = [];
  const transfer = useTableTransfer({
    storage: createStorage(),
    invokeWorkbench: async (command, payload) => {
      calls.push([command, payload]);
      return payload.templates.map((item) => ({ ...item, scriptPath: `D:\\found\\${item.id}.bat` }));
    },
  });
  const { template } = transfer.addTemplate("分支");

  await transfer.discoverAndFill();
  assert.deepEqual(calls[0][1].templates.map((item) => item.id), ["juesheng-1", "juesheng-2"]);
  assert.equal(transfer.templates.value[0].scriptPath, "D:\\found\\juesheng-1.bat");
  assert.equal(transfer.templates.value.find((item) => item.id === template.id).scriptPath, "");
});

test("run sends the active user template's settings", async () => {
  const calls = [];
  const transfer = useTableTransfer({
    storage: createStorage(),
    invokeWorkbench: async (command, payload) => {
      calls.push([command, payload]);
      return { outputDir: "E:\\branch\\out", updatedDirs: [], copiedFiles: 1 };
    },
  });
  const { template } = transfer.addTemplate("分支");
  assert.equal(transfer.canRun.value, false);
  transfer.updateTemplate(template.id, {
    scriptPath: "E:\\branch\\gen.bat",
    projectRoot: "E:\\branch\\jswz",
    conflictStrategy: "manual",
  });

  await transfer.run();
  const [, payload] = calls.find(([command]) => command === "table_transfer_run");
  assert.equal(payload.request.scriptPath, "E:\\branch\\gen.bat");
  assert.equal(payload.request.projectRoot, "E:\\branch\\jswz");
  assert.equal(payload.request.conflictStrategy, "manual");
});

test("the template list cannot change while a transfer is running", async () => {
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg" },
      { id: "custom-1", name: "分支", scriptPath: "", projectRoot: "" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    invokeWorkbench: async (command) => (command === "table_transfer_run" ? new Promise(() => {}) : null),
  });
  assert.equal(transfer.templates.value.length, 3);

  const running = transfer.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transfer.dialog.status, "running");
  assert.equal(transfer.addTemplate("新的").status, "busy");
  assert.equal(transfer.renameTemplate("custom-1", "改名").status, "busy");
  assert.equal(transfer.deleteTemplate("custom-1"), false);
  assert.deepEqual(transfer.templates.value.map((template) => template.name), ["决胜1", "决胜2", "分支"]);
  running.catch(() => {});
});

test("log lines stay capped so a noisy script cannot freeze the dialog", () => {
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage: createStorage() });
  transfer.dialog.jobId = "job-1";
  for (let index = 0; index < 600; index += 1) {
    transfer.handleProgressEvent({
      payload: { jobId: "job-1", stage: "script", status: "running", line: `line-${index}` },
    });
  }
  transfer.handleProgressEvent({
    payload: { jobId: "job-1", stage: "done", status: "succeeded", message: "" },
  });
  assert.ok(transfer.dialog.logLines.length <= 500);
  assert.equal(transfer.dialog.logLines.at(-1), "line-599");
});

test("progress events are filtered by job id and appended to the log", async () => {
  const transfer = useTableTransfer({ invokeWorkbench: async () => ({}), storage: createStorage() });
  transfer.dialog.jobId = "job-1";

  transfer.handleProgressEvent({ payload: { jobId: "other", stage: "svn", status: "running", line: "noise" } });
  assert.equal(transfer.dialog.logLines.length, 0);
  assert.equal(transfer.dialog.stage, "");

  transfer.handleProgressEvent({ payload: { jobId: "job-1", stage: "svn", status: "running", line: "Updating..." } });
  assert.equal(transfer.dialog.stage, "svn");
  assert.equal(transfer.dialog.status, "running");
  // 日志行是批量冲刷的（120ms 节流），终态事件会立即冲刷。
  transfer.handleProgressEvent({ payload: { jobId: "job-1", stage: "done", status: "succeeded", message: "" } });
  assert.deepEqual(transfer.dialog.logLines, ["Updating..."]);
});

test("run reports success through invoke and keeps the result", async () => {
  const bus = createEventBus();
  const calls = [];
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    listen: bus.listen,
    invokeWorkbench: async (command, payload) => {
      calls.push([command, payload]);
      if (command === "table_transfer_run") {
        bus.emit({ jobId: payload.request.jobId, stage: "copy", status: "running", message: "已复制 50 个文件…" });
        return { outputDir: "D:\\tool\\2026-08-17 14-53-56", updatedDirs: [], copiedFiles: 3 };
      }
      return null;
    },
  });

  const result = await transfer.run();
  assert.equal(result.copiedFiles, 3);
  assert.equal(transfer.dialog.status, "succeeded");
  assert.deepEqual(calls[0][0], "table_transfer_run");
  assert.equal(calls[0][1].request.scriptPath, "D:\\tool\\gen.bat");
  assert.equal(calls[0][1].request.conflictStrategy, "theirs");
  assert.ok(calls[0][1].request.jobId);
  assert.ok(transfer.dialog.logLines.includes("已复制 50 个文件…"));
});

test("run without a configured script does nothing", async () => {
  let called = false;
  const transfer = useTableTransfer({
    storage: createStorage(),
    invokeWorkbench: async () => {
      called = true;
      return null;
    },
  });
  assert.equal(transfer.canRun.value, false);
  assert.equal(await transfer.run(), null);
  assert.equal(called, false);
});

test("summarizeTransferError keeps a short banner and points to the log", () => {
  assert.equal(summarizeTransferError("短错误"), "短错误");
  const dump = [
    "svn update 失败（D:\\client2\\jswz）: svn update 失败: exit code: 1",
    "svn: E155027: Tree conflict can only be resolved to 'working' state",
    ...Array.from({ length: 200 }, (_, index) => `U    D:\\client2\\jswz\\file-${index}.png`),
  ].join("\n");
  const summary = summarizeTransferError(dump);
  assert.ok(summary.split("\n").length <= 9);
  assert.match(summary, /svn update 失败/);
  assert.match(summary, /完整细节见下方日志/);
  assert.ok(!summary.includes("file-50.png"));
});

test("run failure keeps a short error banner instead of the full svn dump", async () => {
  const dump = [
    "svn update 失败（D:\\client2\\jswz）: svn update 失败: exit code: 1",
    "svn: E155027: Tree conflict can only be resolved to 'working' state; soultreebaseprop.json not resolved",
    ...Array.from({ length: 180 }, (_, index) => `U    D:\\client2\\jswz\\assets\\bundles\\npc_${index}.png`),
  ].join("\n");
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    invokeWorkbench: async (command) => {
      if (command === "table_transfer_run") throw new Error(dump);
      return null;
    },
  });

  assert.equal(await transfer.run(), null);
  assert.equal(transfer.dialog.status, "failed");
  assert.match(transfer.dialog.errorMessage, /svn update 失败/);
  assert.match(transfer.dialog.errorMessage, /E155027|完整细节见下方日志/);
  assert.ok(
    transfer.dialog.errorMessage.length < dump.length,
    "失败红字不应把整段 SVN 清单铺进弹框",
  );
  assert.ok(!transfer.dialog.errorMessage.includes("npc_50.png"));
});

test("cancel forwards the current job id", async () => {
  const calls = [];
  const storage = createStorage({
    [TABLE_TRANSFER_TEMPLATES_KEY]: JSON.stringify([
      { id: "juesheng-1", scriptPath: "D:\\tool\\gen.bat", projectRoot: "D:\\Versions\\nzg" },
    ]),
  });
  const transfer = useTableTransfer({
    storage,
    invokeWorkbench: async (command, payload) => {
      calls.push([command, payload]);
      if (command === "table_transfer_run") return new Promise(() => {}); // 永不返回，模拟长时间运行
      if (command === "table_transfer_cancel") return true;
      return null;
    },
  });

  const running = transfer.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transfer.dialog.status, "running");

  assert.equal(await transfer.cancel(), true);
  const cancelCall = calls.find(([command]) => command === "table_transfer_cancel");
  assert.ok(cancelCall);
  assert.equal(cancelCall[1].jobId, transfer.dialog.jobId);
  running.catch(() => {});
});

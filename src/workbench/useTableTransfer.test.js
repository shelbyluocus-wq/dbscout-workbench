import test from "node:test";
import assert from "node:assert/strict";

import {
  TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY,
  TABLE_TRANSFER_TEMPLATES_KEY,
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
  // 未知 id 不会混进来，仍是固定两个模板。
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

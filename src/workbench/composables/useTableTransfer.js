import { computed, reactive, shallowRef } from "vue";

export const TABLE_TRANSFER_TEMPLATES_KEY = "dbscout_table_transfer_templates";
export const TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY = "dbscout_table_transfer_active_template";

const PROGRESS_EVENT_NAME = "table-transfer-progress";
const MAX_LOG_LINES = 500;

export const TABLE_TRANSFER_STAGE_LABELS = Object.freeze({
  script: "运行转表脚本",
  locate: "定位转表产出",
  svn: "SVN 更新工程",
  copy: "拷贝进工程",
  done: "完成",
});

// 固定两个预置模板（决胜1/决胜2）：名称与 id 固定，字段可编辑并自动保存。
// 打开对话框时会在非 C 盘按决胜工程结构自动探测脚本和工程；已有有效路径不覆盖。
const PRESET_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "juesheng-1",
    name: "决胜1",
    scriptPath: "",
    projectRoot: "D:\\Versions\\nzg",
    conflictStrategy: "theirs",
  }),
  Object.freeze({
    id: "juesheng-2",
    name: "决胜2",
    scriptPath: "",
    projectRoot: "D:\\client\\jswz",
    conflictStrategy: "theirs",
  }),
]);

function sanitizeConflictStrategy(value) {
  if (value === "mine" || value === "manual") return value;
  return "theirs";
}

function sanitizeTemplate(entry, preset) {
  return {
    id: String(entry?.id || preset.id).trim(),
    name: preset.name,
    scriptPath: String(entry?.scriptPath || "").trim(),
    projectRoot: String(entry?.projectRoot || preset.projectRoot || "").trim(),
    conflictStrategy: sanitizeConflictStrategy(entry?.conflictStrategy),
  };
}

function readTemplates(storage) {
  let stored = [];
  try {
    const parsed = JSON.parse(storage?.getItem?.(TABLE_TRANSFER_TEMPLATES_KEY) || "[]");
    if (Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = [];
  }
  const storedById = new Map();
  for (const entry of stored) {
    const id = String(entry?.id || "").trim();
    if (id) storedById.set(id, entry);
  }
  return PRESET_TEMPLATES.map((preset) =>
    sanitizeTemplate({ ...preset, ...(storedById.get(preset.id) || {}) }, preset),
  );
}

function writeTemplates(storage, templates) {
  try {
    storage?.setItem?.(TABLE_TRANSFER_TEMPLATES_KEY, JSON.stringify(templates));
  } catch {
    // best-effort persistence
  }
}

function readActiveTemplateId(storage) {
  try {
    const value = String(storage?.getItem?.(TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY) || "").trim();
    return PRESET_TEMPLATES.some((preset) => preset.id === value) ? value : PRESET_TEMPLATES[0].id;
  } catch {
    return PRESET_TEMPLATES[0].id;
  }
}

function writeActiveTemplateId(storage, id) {
  try {
    storage?.setItem?.(TABLE_TRANSFER_ACTIVE_TEMPLATE_KEY, String(id || ""));
  } catch {
    // best-effort persistence
  }
}

function defaultJobId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `table-transfer-${Date.now().toString(36)}-${random}`;
}

function errorMessage(error) {
  return String(error?.message || error || "未知错误");
}

/** 游戏工程「浏览」始终打开 assets：选了工程根就拼上 assets，已经是 assets 就原样。 */
export function projectFolderToReveal(path) {
  const value = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!value) return value;
  const leaf = value.split(/[\\/]/).pop() || "";
  if (leaf.toLowerCase() === "assets") return value;
  const separator = value.includes("\\") ? "\\" : "/";
  return `${value}${separator}assets`;
}

/**
 * 一键转表：模板管理 + 运行状态 + 进度事件订阅。事件载荷是后端
 * `TableTransferProgress`（camelCase），按 jobId 过滤，line 字段追加进日志。
 */
export function useTableTransfer({
  invokeWorkbench,
  listen = null,
  storage = globalThis.localStorage,
  createJobId = defaultJobId,
} = {}) {
  const templates = shallowRef(readTemplates(storage));
  const activeTemplateId = shallowRef(readActiveTemplateId(storage));
  const result = shallowRef(null);
  const dialog = reactive({
    open: false,
    status: "idle", // idle | running | succeeded | failed | cancelled
    stage: "",
    stageMessage: "",
    logLines: [],
    jobId: "",
    errorMessage: "",
  });
  let unlistenProgress = null;

  const activeTemplate = computed(
    () =>
      templates.value.find((template) => template.id === activeTemplateId.value) ||
      templates.value[0] ||
      null,
  );
  const isRunning = computed(() => dialog.status === "running");
  const canRun = computed(
    () =>
      !isRunning.value &&
      Boolean(activeTemplate.value?.scriptPath) &&
      Boolean(activeTemplate.value?.projectRoot),
  );
  const stageLabel = computed(
    () => TABLE_TRANSFER_STAGE_LABELS[dialog.stage] || "准备就绪",
  );

  function setActiveTemplate(id) {
    if (!templates.value.some((template) => template.id === id)) return;
    activeTemplateId.value = id;
    writeActiveTemplateId(storage, id);
  }

  function updateTemplate(id, patch = {}) {
    const next = templates.value.map((template) => {
      if (template.id !== id) return template;
      const preset = PRESET_TEMPLATES.find((item) => item.id === id) || template;
      return sanitizeTemplate({ ...template, ...patch }, preset);
    });
    templates.value = next;
    writeTemplates(storage, next);
  }

  async function discoverAndFill() {
    if (!invokeWorkbench) return;
    try {
      const current = templates.value.map((template) => ({
        id: template.id,
        scriptPath: template.scriptPath,
        projectRoot: template.projectRoot,
      }));
      const resolved = await invokeWorkbench("table_transfer_discover_paths", { templates: current });
      if (!Array.isArray(resolved)) return;
      for (const item of resolved) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        const patch = {};
        if (item.scriptPath) patch.scriptPath = String(item.scriptPath);
        if (item.projectRoot) patch.projectRoot = String(item.projectRoot);
        if (Object.keys(patch).length) updateTemplate(id, patch);
      }
    } catch {
      // 找不到就保持原样，用户仍可手动选。
    }
  }

  async function pickScript(templateId) {
    if (!invokeWorkbench) return;
    try {
      const path = await invokeWorkbench("table_transfer_pick_script");
      if (path) updateTemplate(templateId, { scriptPath: String(path) });
    } catch (error) {
      dialog.errorMessage = `选择转表脚本失败：${errorMessage(error)}`;
    }
  }

  async function revealPath(path) {
    const target = String(path || "").trim();
    if (!invokeWorkbench || !target) return false;
    try {
      await invokeWorkbench("reveal_local_path", { path: target });
      return true;
    } catch (error) {
      dialog.errorMessage = `打开路径失败：${errorMessage(error)}`;
      return false;
    }
  }

  async function pickProjectDir(templateId) {
    if (!invokeWorkbench) return;
    try {
      const path = await invokeWorkbench("table_transfer_pick_project_dir");
      if (path) updateTemplate(templateId, { projectRoot: String(path) });
    } catch (error) {
      dialog.errorMessage = `选择游戏工程文件夹失败：${errorMessage(error)}`;
    }
  }

  function pushLog(line) {
    dialog.logLines.push(line);
    if (dialog.logLines.length > MAX_LOG_LINES) {
      dialog.logLines.splice(0, dialog.logLines.length - MAX_LOG_LINES);
    }
  }

  // 转表脚本可能每秒输出几百行；逐行写入 reactive 数组会让界面逐行卡。
  // 这里把日志行先缓冲，每 120ms 批量落一次（一次响应式更新），终态时立即
  // 冲刷，保证界面流畅且日志完整。
  let pendingLogs = [];
  let flushTimer = null;

  function flushLogs() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingLogs.length) return;
    dialog.logLines.push(...pendingLogs);
    pendingLogs = [];
    if (dialog.logLines.length > MAX_LOG_LINES) {
      dialog.logLines.splice(0, dialog.logLines.length - MAX_LOG_LINES);
    }
  }

  function enqueueLog(line) {
    pendingLogs.push(line);
    if (!flushTimer) {
      flushTimer = setTimeout(flushLogs, 120);
    }
  }

  function handleProgressEvent(event) {
    const payload = event?.payload || event || {};
    const jobId = String(payload.jobId || payload.job_id || "");
    if (!dialog.jobId || jobId !== dialog.jobId) return;
    if (payload.stage) dialog.stage = String(payload.stage);
    if (payload.status) dialog.status = String(payload.status);
    if (payload.message) dialog.stageMessage = String(payload.message);
    const raw = String(payload.line ?? payload.message ?? "");
    if (raw.trim()) {
      // 后端把日志按 120ms/50 行聚合成一个事件，line 里可能含多行。
      for (const part of raw.split("\n")) {
        const line = part.trimEnd();
        if (line.trim()) enqueueLog(line);
      }
    }
    if (payload.status && payload.status !== "running") flushLogs();
  }

  async function ensureProgressListener() {
    if (unlistenProgress || !listen) return;
    const unlisten = await listen(PROGRESS_EVENT_NAME, handleProgressEvent);
    unlistenProgress = typeof unlisten === "function" ? unlisten : null;
  }

  async function run() {
    if (!invokeWorkbench || !canRun.value) return null;
    const template = activeTemplate.value;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingLogs = [];
    dialog.jobId = createJobId();
    dialog.status = "running";
    dialog.stage = "script";
    dialog.stageMessage = "正在启动转表脚本…";
    dialog.errorMessage = "";
    dialog.logLines = [];
    result.value = null;
    try {
      await ensureProgressListener();
      const runResult = await invokeWorkbench("table_transfer_run", {
        request: {
          jobId: dialog.jobId,
          scriptPath: template.scriptPath,
          projectRoot: template.projectRoot,
          conflictStrategy: template.conflictStrategy,
        },
      });
      result.value = runResult;
      if (dialog.status === "running") dialog.status = "succeeded";
      flushLogs();
      return runResult;
    } catch (error) {
      const message = errorMessage(error);
      if (dialog.status === "running") {
        dialog.status = /已取消/.test(message) ? "cancelled" : "failed";
      }
      dialog.errorMessage = dialog.status === "failed" ? message : "";
      flushLogs();
      return null;
    }
  }

  async function cancel() {
    if (!invokeWorkbench || dialog.status !== "running") return false;
    try {
      return Boolean(await invokeWorkbench("table_transfer_cancel", { jobId: dialog.jobId }));
    } catch {
      return false;
    }
  }

  /**
   * 打开对话框并补全能自动找到的路径，等用户点「开始转表」。
   */
  function open() {
    dialog.open = true;
    dialog.errorMessage = "";
    void discoverAndFill();
  }

  function close() {
    if (isRunning.value) return;
    dialog.open = false;
  }

  function dispose() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingLogs = [];
    try {
      unlistenProgress?.();
    } finally {
      unlistenProgress = null;
    }
  }

  return {
    templates,
    activeTemplateId,
    activeTemplate,
    result,
    dialog,
    isRunning,
    canRun,
    stageLabel,
    setActiveTemplate,
    updateTemplate,
    pickScript,
    pickProjectDir,
    revealPath,
    projectFolderToReveal,
    discoverAndFill,
    run,
    cancel,
    open,
    close,
    handleProgressEvent,
    dispose,
  };
}

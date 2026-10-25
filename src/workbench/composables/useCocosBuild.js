import { computed, reactive, watch } from "vue";
import { t } from "../i18n/index.js";
import { invokeWorkbench, listenWorkbenchEvent } from "../utils/tauriBridge.js";
import { cocosBuildOptions, cocosBuildProblems, cocosFamily, cocosOutputDir } from "../utils/cocosBuildCommand.js";
import { ReleaseTaskError } from "../utils/releaseFlowDemoDriver.js";

export const COCOS_BUILD_EVENT = "cocos-build-progress";
const MAX_LINES = 600;

/**
 * Real Cocos Creator builds through the backend (cocos_build.rs). In the
 * browser preview the mock backend answers instead and marks every result
 * `simulated`, so the page never shows a simulated build as a real one.
 */
export function createCocosBackend({ invoke = invokeWorkbench, listen = listenWorkbenchEvent } = {}) {
  return {
    inspect: (options) => invoke("cocos_inspect_project", {
      request: { projectPath: options.projectPath || "", configPath: options.configPath || "", editorPath: options.editorPath || "" },
    }),
    findEditors: (projectPath) => invoke("cocos_find_editors", { projectPath: projectPath || "" }),
    outputStatus: (path) => invoke("cocos_output_status", { path }),
    pickEditor: (start) => invoke("cocos_pick_editor", { start: start || "" }),
    pickProject: (start) => invoke("cocos_pick_project", { start: start || "" }),
    pickConfig: (start) => invoke("cocos_pick_config", { start: start || "" }),
    reveal: (path) => invoke("reveal_local_path", { path }),
    async build(request, onLine, signal) {
      const unlisten = await listen(COCOS_BUILD_EVENT, (event) => {
        const payload = event?.payload ?? event;
        if (payload?.jobId === request.jobId) onLine(payload);
      });
      const stop = () => void invoke("cocos_build_cancel", { jobId: request.jobId }).catch(() => {});
      signal?.addEventListener("abort", stop, { once: true });
      try {
        return await invoke("cocos_build_start", { request });
      } finally {
        signal?.removeEventListener("abort", stop);
        unlisten?.();
      }
    },
  };
}

let jobSequence = 0;

export function createBuildJobId(prefix = "build") {
  jobSequence = (jobSequence + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}-${jobSequence.toString(36)}`;
}

/** The backend request for a build of `options`, using the project's engine family. */
export function buildRequest(options, { jobId, engineVersion = "", simulate = "" }) {
  const request = {
    jobId,
    editorPath: options.editorPath,
    projectPath: options.projectPath,
    family: cocosFamily(engineVersion || options.version) || 3,
    platform: options.platform,
    configPath: options.configPath,
    outputName: options.outputName,
    debug: Boolean(options.debug),
    md5Cache: options.md5Cache !== false,
    qaGuard: options.qaGuard !== false,
  };
  // Only the browser preview's mock reads this; the backend ignores it.
  if (simulate) request.simulate = simulate;
  return request;
}

export function buildLineTone(line) {
  const text = String(line?.line ?? "");
  if (/\b(error|failed|失败|錯誤|错误)\b/i.test(text) || /^\[?error/i.test(text)) return "error";
  if (line?.stream === "err" || /\bwarn(ing)?\b/i.test(text)) return "warning";
  if (line?.stream === "info") return "muted";
  return "";
}

/**
 * The build step of an update as a real build: the same checks and backend
 * as the client build page, with the editor's output as the step's log.
 */
export function createReleaseBuildDriver({ backend = createCocosBackend(), simulateFailure = () => false } = {}) {
  return {
    handles: (taskId) => taskId === "build.cocos",
    async run(taskId, context, io) {
      const options = context.build;
      io.progress(null);
      const project = await backend.inspect(options);
      const problems = cocosBuildProblems(options, { project, editorVersion: project?.editorVersion }).filter((problem) => problem.level === "error");
      if (problems.length) {
        throw new ReleaseTaskError("buildPrecheck", problems[0].code, { result: { problems, simulated: Boolean(project?.simulated) } });
      }
      const request = buildRequest(options, {
        jobId: createBuildJobId(context.runId || "run"),
        engineVersion: project?.engine?.version,
        simulate: simulateFailure(context) ? "failure" : "",
      });
      const result = await backend.build(request, (line) => io.log(line.line, buildLineTone(line)), io.signal);
      const outcome = { ...result, engineVersion: project?.engine?.version || "", platform: options.platform, qaChecked: result?.qa?.checked || 0 };
      if (result?.outcome === "cancelled") {
        const error = new Error("cancelled");
        error.code = "cancelled";
        throw error;
      }
      if (result?.outcome !== "success") throw new ReleaseTaskError("buildFailed", "Cocos build failed", { exitCode: result?.exitCode, result: outcome });
      if (result.qa?.status === "findings") throw new ReleaseTaskError("qaFindings", "release guard found QA tooling", { result: outcome });
      return outcome;
    },
  };
}

/**
 * The confirmation before a real build: the project, the engine and editor
 * versions, the platform and the output folder, and a warning when the
 * folder already holds a build. `direct` adds the note that the platform's
 * update has not reached its build step.
 */
export function cocosBuildConfirmOptions({ options, project, outputDir, output, direct = false, preview = false }) {
  const overwrite = Boolean(output?.exists && output.entries > 0);
  const message = [
    direct ? t("releaseFlow.build.confirm.direct") : "",
    overwrite ? t("releaseFlow.build.confirm.overwrite", { count: output.entries }) : t("releaseFlow.build.confirm.message"),
  ].filter(Boolean).join("\n");
  return {
    title: t(direct ? "releaseFlow.build.confirm.directTitle" : "releaseFlow.build.confirm.title"),
    message,
    items: [
      t("releaseFlow.build.confirm.project", { path: options.projectPath }),
      t("releaseFlow.build.confirm.engine", { project: project?.engine?.version || "?", editor: project?.editorVersion || options.version || "?" }),
      t("releaseFlow.build.confirm.platform", { platform: options.platform }),
      t("releaseFlow.build.confirm.output", { path: outputDir }),
    ],
    note: t(preview ? "releaseFlow.build.confirm.preview" : "releaseFlow.build.confirm.real"),
    confirmText: t(overwrite ? "releaseFlow.build.confirm.overwriteAction" : "releaseFlow.build.confirm.action"),
    cancelText: t("releaseFlow.cancel"),
    danger: overwrite,
  };
}

/** One driver per task: the first that handles it, otherwise the last one. */
export function composeDrivers(...drivers) {
  const fallback = drivers.at(-1);
  return {
    run(taskId, context, io) {
      const driver = drivers.find((candidate) => candidate.handles?.(taskId)) || fallback;
      return driver.run(taskId, context, io);
    },
  };
}

/**
 * The client build page: one target's settings (a platform's or another
 * client folder's), what its project and editors are, and one build with its
 * live log. Finished builds go to the history.
 */
export function useCocosBuildTool({
  workspace,
  backend = createCocosBackend(),
  now = () => Date.now(),
  // The settings being built: the build page's target, or an update's platform.
  targetId: readTargetId = () => workspace.state.build.targetId,
  target: readTarget = () => workspace.buildTarget(readTargetId()),
}) {
  const state = reactive({
    project: null,
    editors: [],
    inspecting: false,
    output: null,
    status: "idle", // idle | running | done | failed | cancelled
    lines: [],
    result: null,
    error: "",
    startedAt: 0,
    finishedAt: 0,
  });
  let controller = null;

  const targetId = computed(readTargetId);
  const target = computed(readTarget);
  const options = computed(() => cocosBuildOptions(target.value || {}));
  const engineVersion = computed(() => state.project?.engine?.version || "");
  const editorVersion = computed(() => state.project?.editorVersion || options.value.version);
  const outputDir = computed(() => cocosOutputDir({ ...options.value, version: engineVersion.value || options.value.version }));
  const problems = computed(() => cocosBuildProblems(options.value, { project: state.project, editorVersion: editorVersion.value }));
  const blocked = computed(() => problems.value.some((problem) => problem.level === "error"));
  const running = computed(() => state.status === "running");

  let inspection = 0;
  async function inspect() {
    const ticket = ++inspection;
    state.inspecting = true;
    try {
      const [project, editors, output] = await Promise.all([
        backend.inspect(options.value),
        backend.findEditors(options.value.projectPath),
        outputDir.value ? backend.outputStatus(outputDir.value) : null,
      ]);
      if (ticket !== inspection) return;
      state.project = project;
      state.editors = Array.isArray(editors) ? editors : [];
      state.output = output;
    } catch (error) {
      if (ticket === inspection) state.error = String(error?.message || error);
    } finally {
      if (ticket === inspection) state.inspecting = false;
    }
  }

  // Fresh facts whenever the target or its paths change.
  const stopWatch = watch(
    () => [targetId.value, options.value.projectPath, options.value.editorPath, options.value.configPath, outputDir.value],
    () => void inspect(),
    { immediate: true },
  );

  function pushLine(text, tone = "") {
    state.lines.push({ text, tone });
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  }

  /** Run the build; `simulate` only reaches the browser preview's mock. */
  async function build({ simulate = "" } = {}) {
    if (running.value || blocked.value) return null;
    controller = new AbortController();
    Object.assign(state, { status: "running", lines: [], result: null, error: "", startedAt: now(), finishedAt: 0 });
    const request = buildRequest(options.value, { jobId: createBuildJobId("tool"), engineVersion: engineVersion.value, simulate });
    try {
      const result = await backend.build(request, (line) => pushLine(line.line, buildLineTone(line)), controller.signal);
      state.result = result;
      state.status = result?.outcome === "cancelled" ? "cancelled" : result?.outcome === "success" && result.qa?.status !== "findings" ? "done" : "failed";
    } catch (error) {
      state.status = "failed";
      state.error = String(error?.message || error);
      pushLine(state.error, "error");
    } finally {
      state.finishedAt = now();
      controller = null;
      record(request);
      void inspect();
    }
    return state.result;
  }

  function record(request) {
    const platform = targetId.value === "custom" ? null : workspace.platformById(targetId.value);
    workspace.recordTool?.({
      kind: "build",
      platformId: platform?.id || "",
      platformName: platform?.name || target.value?.name || "",
      demo: Boolean(state.result?.simulated),
      outcome: state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : "failed",
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      details: {
        project: request.projectPath,
        engineVersion: engineVersion.value,
        editorVersion: editorVersion.value,
        platform: request.platform,
        outputDir: state.result?.outputDir || outputDir.value,
        exitCode: state.result?.exitCode ?? null,
        outcome: state.result?.outcome || "",
        qa: state.result?.qa || null,
        error: state.error,
      },
      logs: state.lines,
    });
  }

  function cancel() {
    controller?.abort();
  }

  /** Change the target's build settings (a platform's are shared with its update). */
  function update(patch) {
    return workspace.updateBuildTarget(targetId.value, patch);
  }

  function dispose() {
    controller?.abort();
    stopWatch();
  }

  return {
    state,
    targetId,
    target,
    options,
    engineVersion,
    editorVersion,
    outputDir,
    problems,
    blocked,
    running,
    backend,
    inspect,
    build,
    cancel,
    update,
    dispose,
  };
}

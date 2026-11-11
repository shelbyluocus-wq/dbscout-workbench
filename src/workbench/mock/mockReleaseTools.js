// Browser-preview stand-ins for the release workspace's real tools: the
// exclusion picker, the SVN working copy and Cocos Creator builds. Nothing is
// read from or written to a disk; every answer carries `simulated: true` so
// the pages say so. Tests choose what the picker returns through
// `globalThis.__dbscoutMockPick` (a path, a function of the request, or null
// to cancel).

import { emitMockEvent } from "./mockEventBus.js";
import { DEMO_COCOS_FAILURE_LOG, DEMO_COCOS_LOG, DEMO_COCOS_VERSION } from "../utils/releaseFlowDemo.js";
import { createDemoSvnSource } from "../utils/releaseSvnDemo.js";
import { cocosOutputDir } from "../utils/cocosBuildCommand.js";

const COMMANDS = new Set([
  "release_pick_exclusion",
  "svn_wc_info",
  "svn_wc_status",
  "svn_wc_update",
  "svn_wc_file_diff",
  "svn_wc_commit",
  "svn_wc_revert",
  "svn_wc_resolve",
  "svn_wc_log",
  "svn_wc_pick_folder",
  "cocos_inspect_project",
  "cocos_find_editors",
  "cocos_output_status",
  "cocos_build_start",
  "cocos_build_cancel",
  "cocos_pick_editor",
  "cocos_pick_project",
  "cocos_pick_config",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(path) {
  return String(path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/* ── Exclusion picker ── */

function pickResult(status, extra = {}) {
  return { status, kind: "", relative: "", root: "", path: "", simulated: true, ...extra };
}

// Lexical checks only: the preview has no disk; the backend also resolves links.
function pickExclusion(request) {
  const roots = (request?.roots || []).filter((root) => normalize(root));
  if (!roots.length) return pickResult("rootMissing");
  const hook = globalThis.__dbscoutMockPick;
  const picked = typeof hook === "function" ? hook(request) : hook;
  if (!picked) return pickResult("cancelled");
  const path = normalize(picked);
  if (path.split("/").includes("..")) return pickResult("outside", { path: picked });
  for (const root of roots) {
    const base = normalize(root);
    if (path.toLowerCase() === base.toLowerCase()) return pickResult("isRoot", { path: picked });
    if (path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      return pickResult("picked", {
        kind: request.kind === "folder" ? "folder" : "file",
        relative: path.slice(base.length + 1),
        root,
        path: picked,
      });
    }
  }
  return pickResult("outside", { path: picked });
}

/* ── SVN working copies ── */

// Beside the copied files, the tool's preview shows a file svn does not know
// yet and a conflict, so every part of the page can be tried.
const EXTRA_ENTRIES = Object.freeze([
  { path: "docs/release-notes.txt", item: "unversioned", content: "10/28 版本说明\n- 开放红龙女王\n- 修复坐骑重生\n" },
  { path: "assets/resources/version.manifest", item: "conflicted" },
]);

const workingCopies = new Map();

function workingCopy(root) {
  const key = normalize(root).toLowerCase();
  if (!workingCopies.has(key)) {
    const memory = { committed: [], reverted: [], revision: 0, commits: [] };
    workingCopies.set(key, {
      memory,
      extras: EXTRA_ENTRIES.map((entry) => ({ ...entry })),
      source: createDemoSvnSource({ memory, platformId: () => "preview", wait: (ms) => sleep(ms / 2) }),
    });
  }
  return workingCopies.get(key);
}

function extraEntry(entry) {
  return { path: entry.path, item: entry.item, props: "none", kind: "file", treeConflict: false, locked: false };
}

async function svn(command, request) {
  const root = request?.root;
  if (command === "svn_wc_pick_folder") return null;
  if (!normalize(root)) throw new Error("notWorkingCopy: ");
  const copy = workingCopy(root);
  const paths = request.paths || [];
  if (command === "svn_wc_info") return { ...(await copy.source.info(root)), url: "^/release/jswz", relativeUrl: "^/release/jswz" };
  if (command === "svn_wc_status") return [...(await copy.source.status(root)), ...copy.extras.map(extraEntry)];
  if (command === "svn_wc_update") {
    const info = await copy.source.info(root);
    const conflicts = copy.extras.filter((entry) => entry.item === "conflicted").map((entry) => entry.path);
    return { revision: info.revision, updated: 4, conflicts, lines: [`Updated to revision ${info.revision}.`], simulated: true };
  }
  if (command === "svn_wc_file_diff") {
    const extra = copy.extras.find((entry) => entry.path === paths[0]);
    if (extra?.item === "unversioned") return { path: extra.path, diff: "", content: extra.content, binary: false, tooLarge: false, encoding: "utf-8" };
    if (extra) {
      // svn diff shows a conflicted file with its conflict markers as added lines.
      const diff = [
        `Index: ${extra.path}`, "===", `--- ${extra.path}`, `+++ ${extra.path}`, "@@ -1,3 +1,7 @@", " {",
        '-    "version": "1.023",', "+<<<<<<< .mine", '+    "version": "1.024",', "+=======", '+    "version": "1.023",', "+>>>>>>> .r52817", " }",
      ].join("\n");
      return { path: extra.path, diff, content: null, binary: false, tooLarge: false, encoding: "utf-8" };
    }
    return copy.source.fileDiff(root, paths[0]);
  }
  if (command === "svn_wc_commit") {
    const conflicted = paths.find((path) => copy.extras.some((entry) => entry.path === path && entry.item === "conflicted"));
    if (conflicted) throw new Error(`conflict: svn: E155015: Commit failed: '${conflicted}' remains in conflict`);
    const added = paths.filter((path) => copy.extras.some((entry) => entry.path === path && entry.item === "unversioned"));
    copy.extras = copy.extras.filter((entry) => !added.includes(entry.path));
    return { ...(await copy.source.commit(root, paths.filter((path) => !added.includes(path)).concat(added), request.message)), added };
  }
  if (command === "svn_wc_revert") {
    copy.extras = copy.extras.filter((entry) => !(paths.includes(entry.path) && entry.item !== "unversioned"));
    return copy.source.revert(root, paths);
  }
  if (command === "svn_wc_resolve") {
    copy.extras = copy.extras.filter((entry) => !(paths.includes(entry.path) && entry.item === "conflicted"));
    return copy.source.resolve(root, paths);
  }
  return copy.source.log(root);
}

/* ── Cocos Creator builds ── */

const builds = new Map();

function parentFolder(path) {
  const text = String(path || "").replace(/[\\/]+$/, "");
  const index = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  return index > 0 ? text.slice(0, index) : "";
}

function inspectProject(request) {
  const projectPath = String(request?.projectPath || "").trim();
  const info = {
    exists: Boolean(projectPath),
    name: projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : "",
    engine: projectPath ? { version: DEMO_COCOS_VERSION, family: 3 } : null,
    qaGuard: Boolean(projectPath),
    buildConfigs: [],
    configExists: request?.configPath ? true : null,
    editorExists: request?.editorPath ? true : null,
    editorVersion: request?.editorPath ? DEMO_COCOS_VERSION : "",
    simulated: true,
  };
  return info;
}

function findEditors(projectPath) {
  const parent = parentFolder(String(projectPath || "").trim());
  if (!parent) return [];
  const separator = parent.includes("\\") ? "\\" : "/";
  return [{ version: DEMO_COCOS_VERSION, path: `${parent}${separator}creator3.8${separator}CocosCreator.exe`, source: "nearby", simulated: true }];
}

async function build(request) {
  const job = { cancelled: false };
  builds.set(request.jobId, job);
  const started = Date.now();
  const emit = (stream, line, stage = "build") => emitMockEvent("cocos-build-progress", { jobId: request.jobId, stage, stream, line });
  const outputDir = cocosOutputDir({ projectPath: request.projectPath, version: request.family === 2 ? "2.4" : "3", platform: request.platform, outputName: request.outputName });
  const result = (outcome, exitCode, extra = {}) => ({
    exitCode,
    outcome,
    outputDir,
    outputExists: outcome === "success",
    durationMs: Date.now() - started,
    logPath: "",
    lines: 0,
    qa: null,
    simulated: true,
    ...extra,
  });
  try {
    emit("info", `> "${request.editorPath}" ${request.family === 2 ? "--path" : "--project"} "${request.projectPath}" --build "platform=${request.platform}"`);
    const failure = request.simulate === "failure";
    const lines = failure ? DEMO_COCOS_LOG.slice(0, 7) : DEMO_COCOS_LOG;
    for (const [line] of lines) {
      await sleep(110);
      if (job.cancelled) return result("cancelled", null);
      emit("out", line.replace("{version}", DEMO_COCOS_VERSION).replace("{project}", request.projectPath));
    }
    if (failure) {
      for (const line of DEMO_COCOS_FAILURE_LOG) emit("err", line);
      return result("buildError", 34);
    }
    let qa = null;
    if (request.qaGuard) {
      emit("info", `> node qa-tests/QAReleaseGuard.mjs "${outputDir}"`, "qa");
      await sleep(200);
      qa = { status: "passed", checked: 1286, findings: [], message: "" };
    }
    return result("success", request.family === 2 ? 0 : 36, { qa, lines: lines.length });
  } finally {
    builds.delete(request.jobId);
  }
}

export function createMockReleaseTools() {
  return {
    handles: (command) => COMMANDS.has(command),
    async invoke(command, payload = {}) {
      const request = payload.request || payload;
      if (command === "release_pick_exclusion") return pickExclusion(request);
      if (command.startsWith("svn_wc_")) return svn(command, request);
      if (command === "cocos_inspect_project") return inspectProject(request);
      if (command === "cocos_find_editors") return findEditors(payload.projectPath);
      if (command === "cocos_output_status") return { exists: false, entries: 0, modifiedAt: 0, simulated: true };
      if (command === "cocos_build_start") return build(request);
      if (command === "cocos_build_cancel") {
        const job = builds.get(payload.jobId);
        if (job) job.cancelled = true;
        return Boolean(job);
      }
      // The preview has no native file dialogs; a pick is a cancel.
      return null;
    },
    reset() {
      workingCopies.clear();
      builds.clear();
    },
  };
}


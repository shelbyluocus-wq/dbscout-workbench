import { computed, reactive } from "vue";
import { invokeWorkbench } from "../utils/tauriBridge.js";
import { parseHunks, parseUnifiedDiff } from "../utils/unifiedDiff.js";

const MAX_LOG = 30;

/** Real svn commands through the backend (svn_workspace.rs). */
export function createSvnBackendSource({ invoke = invokeWorkbench } = {}) {
  const call = (command, request) => invoke(command, { request });
  return {
    kind: "backend",
    info: (root) => call("svn_wc_info", { root }),
    status: (root) => call("svn_wc_status", { root }),
    update: (root) => call("svn_wc_update", { root }),
    fileDiff: (root, path, unversioned) => call("svn_wc_file_diff", { root, paths: [path], unversioned }),
    commit: (root, paths, message) => call("svn_wc_commit", { root, paths, message }),
    revert: (root, paths) => call("svn_wc_revert", { root, paths }),
    resolve: (root, paths, accept) => call("svn_wc_resolve", { root, paths, accept }),
    log: (root, limit) => call("svn_wc_log", { root, limit }),
    pickFolder: (start) => invoke("svn_wc_pick_folder", { start: start || "" }),
  };
}

/** "outOfDate" from "outOfDate: svn: E155011 …"; "failed" for anything else. */
export function svnErrorCode(error) {
  const match = /^([a-zA-Z]+):\s/.exec(String(error?.message || error || ""));
  return match ? match[1] : "failed";
}

export function svnErrorDetail(error) {
  return String(error?.message || error || "").replace(/^[a-zA-Z]+:\s/, "");
}

/** An unversioned text file shown as one added hunk. */
function addedFile(path, content) {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  return { path, hunks: parseHunks(hunk), properties: [], binary: false };
}

// Changes a person can pick for a commit; conflicts must be resolved first.
const COMMITTABLE = new Set(["modified", "added", "deleted", "replaced", "unversioned", "missing"]);
const REVERTABLE = new Set(["modified", "added", "deleted", "replaced", "missing", "conflicted"]);

export function canCommit(entry) {
  return COMMITTABLE.has(entry.item) || (entry.item === "normal" && entry.props === "modified");
}

export function canRevert(entry) {
  return REVERTABLE.has(entry.item) || entry.props === "modified" || entry.treeConflict === true;
}

export function isConflict(entry) {
  return entry.item === "conflicted" || entry.treeConflict === true || entry.props === "conflicted";
}

/**
 * One working copy in the SVN tool (after Cairn's changes view): its changes
 * with check boxes, one file's diff, commit, revert, conflict resolution and
 * the log. `source` does the work; `onRecord` keeps finished operations.
 */
export function useSvnWorkspace({ source, onRecord = () => {}, now = () => Date.now() }) {
  const state = reactive({
    root: "",
    info: null,
    entries: [],
    loading: false,
    error: "",
    selected: "",
    checked: {},
    diff: null,
    diffLoading: false,
    diffError: "",
    log: [],
    logLoading: false,
    logError: "",
    logLoaded: false,
    busy: "",
    message: "",
    notice: null,
  });

  const conflicts = computed(() => state.entries.filter(isConflict));
  const changes = computed(() => state.entries.filter((entry) => !isConflict(entry) && entry.item !== "unversioned"));
  const unversioned = computed(() => state.entries.filter((entry) => entry.item === "unversioned"));
  const checkedPaths = computed(() => state.entries.filter((entry) => state.checked[entry.path]).map((entry) => entry.path));
  const selectedEntry = computed(() => state.entries.find((entry) => entry.path === state.selected) || null);

  let ticket = 0;

  async function open(root) {
    state.root = String(root || "").trim();
    state.log = [];
    state.logLoaded = false;
    state.notice = null;
    return refresh();
  }

  async function refresh() {
    const current = ++ticket;
    state.loading = true;
    state.error = "";
    try {
      if (!state.root) throw new Error("notWorkingCopy: ");
      const [info, entries] = await Promise.all([source.info(state.root), source.status(state.root)]);
      if (current !== ticket) return false;
      state.info = info;
      state.entries = Array.isArray(entries) ? entries : [];
      const known = new Set(state.entries.map((entry) => entry.path));
      // Changes start checked, as in a commit dialog; unversioned files and conflicts do not.
      const checked = {};
      for (const entry of state.entries) {
        const previous = state.checked[entry.path];
        checked[entry.path] = previous ?? (canCommit(entry) && entry.item !== "unversioned");
      }
      state.checked = checked;
      if (!known.has(state.selected)) state.selected = state.entries.find((entry) => entry.item !== "unversioned")?.path || state.entries[0]?.path || "";
      await loadDiff();
      return true;
    } catch (error) {
      if (current !== ticket) return false;
      state.info = null;
      state.entries = [];
      state.selected = "";
      state.diff = null;
      state.error = String(error?.message || error);
      return false;
    } finally {
      if (current === ticket) state.loading = false;
    }
  }

  let diffTicket = 0;
  async function loadDiff() {
    const entry = selectedEntry.value;
    const current = ++diffTicket;
    state.diffError = "";
    if (!entry || entry.kind === "dir") {
      state.diff = entry ? { path: entry.path, hunks: [], properties: [], binary: false, folder: true } : null;
      return;
    }
    state.diffLoading = true;
    try {
      const unversionedFile = entry.item === "unversioned";
      const result = await source.fileDiff(state.root, entry.path, unversionedFile);
      if (current !== diffTicket) return;
      if (result.tooLarge || result.binary) {
        state.diff = { path: entry.path, hunks: [], properties: [], binary: result.binary, tooLarge: result.tooLarge, encoding: result.encoding };
      } else if (unversionedFile) {
        state.diff = { ...addedFile(entry.path, result.content), encoding: result.encoding };
      } else {
        const [file] = parseUnifiedDiff(result.diff);
        state.diff = { ...(file || { path: entry.path, hunks: [], properties: [], binary: false }), path: entry.path, encoding: result.encoding };
      }
    } catch (error) {
      if (current === diffTicket) state.diffError = String(error?.message || error);
    } finally {
      if (current === diffTicket) state.diffLoading = false;
    }
  }

  function select(path) {
    if (state.selected === path) return;
    state.selected = path;
    void loadDiff();
  }

  function setChecked(path, value) {
    state.checked[path] = Boolean(value);
  }

  function setAllChecked(value) {
    for (const entry of state.entries) if (canCommit(entry)) state.checked[entry.path] = Boolean(value);
  }

  async function operate(kind, run, details) {
    if (state.busy) return null;
    state.busy = kind;
    state.notice = null;
    const startedAt = now();
    try {
      const result = await run();
      state.notice = { kind, tone: "success", result };
      onRecord({ kind, outcome: "done", startedAt, finishedAt: now(), details: { ...details, ...result, root: state.root }, simulated: source.kind === "demo" });
      await refresh();
      return result;
    } catch (error) {
      state.notice = { kind, tone: "danger", error: String(error?.message || error) };
      onRecord({ kind, outcome: "failed", startedAt, finishedAt: now(), details: { ...details, root: state.root, error: String(error?.message || error) }, simulated: source.kind === "demo" });
      return null;
    } finally {
      state.busy = "";
    }
  }

  function commit() {
    const paths = checkedPaths.value.filter((path) => canCommit(state.entries.find((entry) => entry.path === path) || {}));
    const message = state.message.trim();
    if (!paths.length || !message) return Promise.resolve(null);
    return operate("commit", async () => {
      const result = await source.commit(state.root, paths, message);
      state.message = "";
      for (const path of paths) delete state.checked[path];
      return result;
    }, { action: "commit", paths, message });
  }

  function revert(paths) {
    return operate("revert", () => source.revert(state.root, paths), { action: "revert", paths });
  }

  function resolve(paths, accept) {
    return operate("resolve", () => source.resolve(state.root, paths, accept), { action: "resolve", paths, accept });
  }

  async function loadLog() {
    if (state.logLoading || !state.root) return;
    state.logLoading = true;
    state.logError = "";
    try {
      const entries = await source.log(state.root, MAX_LOG);
      state.log = Array.isArray(entries) ? entries : [];
      state.logLoaded = true;
    } catch (error) {
      state.logError = String(error?.message || error);
    } finally {
      state.logLoading = false;
    }
  }

  return {
    state,
    source,
    conflicts,
    changes,
    unversioned,
    checkedPaths,
    selectedEntry,
    open,
    refresh,
    select,
    setChecked,
    setAllChecked,
    commit,
    revert,
    resolve,
    loadLog,
  };
}

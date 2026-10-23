// Demo-only state machine. Deliberately independent of the Tauri/DB bridge.
export const RELEASE_DRAFT_KEY = "dbscout_release_demo_v1";
export const RELEASE_PLATFORMS = ["b", "c", "d"];
export const RELEASE_STEPS = ["prepare", "database", "client", "build", "gm", "launch"];
export const RELEASE_CATEGORIES = ["hero", "mount", "spirit", "pet", "feature"];

export const RELEASE_ACTIONS = Object.freeze({
  preflight: { step: 0, requires: [] },
  dbPreview: { step: 1, requires: ["preflight"] },
  dbApply: { step: 1, requires: ["dbPreview"] },
  svn: { step: 2, requires: ["dbApply"] },
  copy: { step: 2, requires: ["svn"] },
  transfer: { step: 2, requires: ["copy"] },
  diff: { step: 2, requires: ["transfer"] },
  build: { step: 3, requires: ["diff"] },
  activityUpload: { step: 4, requires: ["build"] },
  activityCurrent: { step: 4, requires: ["activityUpload"] },
  activityReload: { step: 4, requires: ["activityCurrent"] },
  clientUpload: { step: 4, requires: ["build"] },
  serverUpload: { step: 4, requires: ["build"] },
  serverCurrent: { step: 4, requires: ["serverUpload"] },
  schedule: { step: 4, requires: ["activityCurrent", "clientUpload", "serverCurrent"] },
  maintenance: { step: 5, requires: ["schedule"] },
  restart: { step: 5, requires: ["maintenance", "serverCurrent"] },
  health: { step: 5, requires: ["restart"] },
  open: { step: 5, requires: ["health"] },
});

export function releaseToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function validReleaseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || "")
    && validReleaseDate(value.slice(0, 10));
}

export function createReleaseDraft(platform, date = releaseToday()) {
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + (platform === "c" ? 7 : platform === "d" ? -7 : 0));
  return {
    config: {
      date, version: `v${date.replaceAll("-", ".")}`, prepared: false,
      sourceDb: "development_cfg", targetDb: `platform_${platform}_cfg`,
      dbExclusions: "platform_settings\nserver_identity", planMode: "preserve",
      plans: RELEASE_CATEGORIES.map((kind, index) => ({
        id: `${kind}-sample`, kind, name: "", rowKey: String(1001 + index),
        table: `demo_${kind}_schedule`, field: "enabled",
        start: start.toISOString().slice(0, 10), end: "", note: "",
        current: index % 2 === 0 ? 0 : 1,
      })),
      sourceClient: "demo/development/client", targetClient: `demo/platform-${platform}/client`,
      fileExclusions: "build/\nlibrary/\ntemp/\nsettings/platform.json",
      templateId: "demo", engine: "CocosCreator", engineVersion: "3.8.8",
      buildTarget: "web-mobile", buildConfig: `demo/platform-${platform}/build-config.json`,
      serverPackage: `demo/platform-${platform}/server.zip`, reloadActivity: false,
      maintenanceStart: `${date}T09:00`, maintenanceEnd: `${date}T10:00`,
      clientOpen: `${date}T10:05`,
    },
    results: {}, logs: [], checks: { database: false, diff: false, launch: false },
    conflicts: {}, preview: null,
  };
}

export function createReleaseState(date = releaseToday()) {
  return {
    schema: 1, platform: "b", step: 0,
    drafts: Object.fromEntries(RELEASE_PLATFORMS.map((id) => [id, createReleaseDraft(id, date)])),
  };
}

// Only known fields survive reload; a corrupt draft must not break the workbench.
export function restoreReleaseState(raw, date = releaseToday()) {
  const fresh = createReleaseState(date);
  try {
    const stored = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (stored?.schema !== 1 || !stored.drafts) return fresh;
    fresh.platform = RELEASE_PLATFORMS.includes(stored.platform) ? stored.platform : "b";
    fresh.step = Number.isInteger(stored.step) ? Math.max(0, Math.min(5, stored.step)) : 0;
    for (const platform of RELEASE_PLATFORMS) {
      const saved = stored.drafts[platform];
      if (!saved?.config) continue;
      const draft = fresh.drafts[platform];
      for (const [key, fallback] of Object.entries(draft.config)) {
        if (key !== "plans" && typeof saved.config[key] === typeof fallback) draft.config[key] = saved.config[key];
      }
      if (Array.isArray(saved.config.plans)) {
        draft.config.plans = saved.config.plans.slice(0, 100).filter((row) => row && typeof row === "object").map((row, index) => ({
          id: `plan-${index}`, kind: RELEASE_CATEGORIES.includes(row.kind) ? row.kind : "feature",
          ...Object.fromEntries(["name", "rowKey", "table", "field", "start", "end", "note"].map((key) => [key, String(row[key] ?? "").slice(0, 2000)])),
          current: row.current === 1 ? 1 : 0,
        }));
      }
      for (const key of Object.keys(RELEASE_ACTIONS)) {
        const status = saved.results?.[key];
        if (["done", "failed", "blocked", "cancelled"].includes(status)) draft.results[key] = status;
        if (status === "running") draft.results[key] = "cancelled";
      }
      for (const key of Object.keys(draft.checks)) draft.checks[key] = saved.checks?.[key] === true;
      for (const key of ["code", "config"]) {
        if (["local", "remote"].includes(saved.conflicts?.[key])) draft.conflicts[key] = saved.conflicts[key];
      }
      // Restore only a valid dependency chain, never an isolated success flag.
      for (const [action, definition] of Object.entries(RELEASE_ACTIONS)) {
        const status = draft.results[action];
        if (!status) continue;
        delete draft.results[action];
        if (definition.requires.some((key) => draft.results[key] !== "done")) continue;
        if (status === "done" && releaseActionBlock(draft, action)) continue;
        draft.results[action] = status;
      }
      if (draft.results.dbPreview !== "done") draft.checks.database = false;
      if (draft.results.transfer !== "done") draft.checks.diff = false;
      if (draft.results.health !== "done") draft.checks.launch = false;
      draft.logs = Array.isArray(saved.logs) ? saved.logs.slice(-100).filter((log) =>
        log && RELEASE_ACTIONS[log.action] && ["running", "done", "failed", "blocked", "cancelled"].includes(log.status)
        && typeof log.time === "string").map(({ action, status, time }) => ({ action, status, time })) : [];
      // Rebuild the preview from the saved inputs, not from untrusted rendered data.
      if (draft.results.dbPreview === "done") draft.preview = planPreview(draft.config);
    }
  } catch { /* Use a new demo when storage is malformed. */ }
  return fresh;
}

export function stepActions(step, config) {
  return Object.entries(RELEASE_ACTIONS)
    .filter(([key, value]) => value.step === step && (key !== "activityReload" || config.reloadActivity))
    .map(([key]) => key);
}

export function stepComplete(draft, step) {
  return stepActions(step, draft.config).every((key) => draft.results[key] === "done");
}

export function invalidateReleaseFrom(draft, step) {
  invalidateReleaseActions(draft, Object.keys(RELEASE_ACTIONS).filter((key) => RELEASE_ACTIONS[key].step >= step));
}

export function invalidateReleaseActions(draft, roots) {
  const invalid = new Set(roots);
  for (const [key, value] of Object.entries(RELEASE_ACTIONS)) {
    if (value.requires.some((dependency) => invalid.has(dependency))
      || (key === "schedule" && invalid.has("activityReload"))) invalid.add(key);
    if (invalid.has(key)) delete draft.results[key];
  }
  if (invalid.has("dbPreview")) { draft.preview = null; draft.checks.database = false; }
  if (invalid.has("svn")) draft.conflicts = {};
  if (invalid.has("diff")) draft.checks.diff = false;
  draft.checks.launch = false;
}

export function planPreview(config) {
  return config.plans.map((row) => {
    const valid = validReleaseDate(config.date) && validReleaseDate(row.start)
      && (!row.end || (validReleaseDate(row.end) && row.end >= row.start))
      && [row.table, row.field, row.rowKey].every((value) => value.trim());
    const enabled = valid && config.date >= row.start && (!row.end || config.date <= row.end);
    return { ...row, valid: Boolean(valid), next: enabled ? 1 : 0, changed: Number(row.current) !== Number(enabled) };
  });
}

export function releaseConfigError(config, step, action = "") {
  if (!validReleaseDate(config.date)) return "dateInvalid";
  if (!config.version.trim()) return "versionRequired";
  if (step === 0 && !config.prepared) return "prepareRequired";
  if (step === 1) {
    if (!["preserve", "overwrite"].includes(config.planMode)) return "planInvalid";
    if (!config.sourceDb.trim() || !config.targetDb.trim()) return "databaseRequired";
    if (config.sourceDb.trim().toLowerCase() === config.targetDb.trim().toLowerCase()) return "sameDatabase";
    if (!config.plans.length || planPreview(config).some((row) => !row.valid)) return "planInvalid";
    const targets = config.plans.map((row) => `${row.table.trim().toLowerCase()}\0${row.rowKey.trim()}\0${row.field.trim().toLowerCase()}`);
    if (new Set(targets).size !== targets.length) return "planDuplicate";
  }
  if (step === 2) {
    const normalize = (value) => value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    const source = normalize(config.sourceClient);
    const target = normalize(config.targetClient);
    if (!source || !target) return "clientRequired";
    if (source === target || source.startsWith(`${target}/`) || target.startsWith(`${source}/`)) return "sameClient";
    if (!config.templateId) return "templateRequired";
  }
  if (step === 3 && (!config.engine.trim() || !config.buildConfig.trim())) return "buildRequired";
  if (step === 4) {
    if ((!action || action.startsWith("server")) && !config.serverPackage.trim()) return "serverRequired";
    if (action && action !== "schedule") return "";
    if (![config.maintenanceStart, config.maintenanceEnd, config.clientOpen].every(validTime)) return "scheduleRequired";
    if (config.maintenanceStart >= config.maintenanceEnd) return "scheduleOrder";
    if (config.clientOpen < config.maintenanceEnd) return "clientTooEarly";
    if (config.maintenanceStart.slice(0, 10) < config.date) return "scheduleBeforeDate";
  }
  return "";
}

export function releaseActionBlock(draft, action) {
  const definition = RELEASE_ACTIONS[action];
  if (!definition) return "unknownAction";
  if (Object.values(draft.results).includes("running")) return "busy";
  if (draft.results[action] === "done") return "alreadyDone";
  if (definition.requires.some((key) => draft.results[key] !== "done")) return "dependency";
  const issue = releaseConfigError(draft.config, definition.step, action);
  if (issue) return issue;
  if (action === "dbApply" && !draft.checks.database) return "reviewDatabase";
  if (action === "svn" && draft.results.svn === "blocked" && (!draft.conflicts.code || !draft.conflicts.config)) return "resolveConflicts";
  if (action === "diff" && !draft.checks.diff) return "reviewDiff";
  if (action === "schedule" && draft.config.reloadActivity && draft.results.activityReload !== "done") return "dependency";
  if (action === "open" && !draft.checks.launch) return "reviewLaunch";
  return "";
}

export const RELEASE_SAMPLE_FILES = Object.freeze([
  { path: "assets/scripts/ReleaseFlags.ts", before: "releaseChannel = 'previous'", after: "releaseChannel = 'current'" },
  { path: "assets/props/hero.json", before: '"enabled": 0', after: '"enabled": 1' },
  { path: "assets/props/features.json", before: '"season": "previous"', after: '"season": "current"' },
  { path: "settings/platform.json", before: '"channel": "platform"', after: '"channel": "development"' },
  { path: ".svn/wc.db", before: "", after: "" },
]);

export function releaseFilePreview(exclusions) {
  const paths = [".svn/", ...exclusions.split(/\r?\n/)].map((path) => path.trim().replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean);
  return RELEASE_SAMPLE_FILES.map((file) => ({
    ...file, excluded: paths.some((path) => file.path === path || file.path.startsWith(path.endsWith("/") ? path : `${path}/`)),
  }));
}

export function releaseArtifact(config, platform) {
  const version = config.version.replace(/[^A-Za-z0-9._-]/g, "_");
  return `client_${platform}_${version}.zip`;
}

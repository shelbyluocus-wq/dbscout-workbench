// Display helpers shared by the release workspace components.
import { language, t } from "../i18n/index.js";
import { AUTOPILOT_RULES } from "../releaseAutopilotState.js";

export function formatReleaseDuration(ms, translate = t) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return translate("releaseFlow.duration.seconds", { seconds });
  if (seconds >= 3600) {
    return translate("releaseFlow.duration.hours", { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) });
  }
  return translate("releaseFlow.duration.minutes", {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, "0"),
  });
}

/** A failure code from the driver as readable text; unknown codes pass through. */
export function releaseErrorText(code, translate = t) {
  const value = String(code || "failed");
  const key = `releaseFlow.error.${value}`;
  const text = translate(key);
  return text === key ? value : text;
}

export function formatReleaseBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function formatReleaseCount(value, locale = language.locale.value) {
  return new Intl.NumberFormat(locale).format(Number(value) || 0);
}

function dateFromIso(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

/** "2026/10/24 (Sat)" style, following the interface language. */
function formatIsoDate(iso, options, locale) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return "";
  return new Intl.DateTimeFormat(locale, options).format(dateFromIso(iso));
}

export function formatReleaseDate(iso, locale = language.locale.value) {
  return formatIsoDate(iso, { year: "numeric", month: "numeric", day: "numeric", weekday: "short" }, locale);
}

/** The weekday alone, beside a date picker that already shows the date. */
export function formatReleaseWeekday(iso, locale = language.locale.value) {
  return formatIsoDate(iso, { weekday: "short" }, locale);
}

/**
 * A datetime-local value ("2026-10-24T10:00") as "10/24 10:00", or just
 * "10:00" when it falls on `dayIso`.
 */
export function formatReleaseTime(value, { dayIso = "", locale = language.locale.value } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  const timeOnly = String(value).slice(0, 10) === dayIso;
  const options = timeOnly
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** "10/24 10:00 – 12:00": the end drops the date when both share a day. */
export function formatReleaseRange(start, end, { dayIso = "", locale = language.locale.value } = {}) {
  const startDay = String(start).slice(0, 10);
  const endText = formatReleaseTime(end, { dayIso: String(end).slice(0, 10) === startDay ? startDay : dayIso, locale });
  return `${formatReleaseTime(start, { dayIso, locale })} – ${endText}`;
}

export function formatClockTime(timestamp, locale = language.locale.value) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(new Date(timestamp));
}

/** What a finished GM operation reported, as one sentence. */
export function gmResultText(taskId, result = {}, translate = t) {
  const key = `releaseFlow.task.${taskId}.done`;
  const value = result || {};
  switch (taskId) {
    case "gm.configPack":
      return translate(key, { version: value.version, tables: formatReleaseCount(value.tables), size: formatReleaseBytes(value.sizeBytes) });
    case "gm.configApply":
      return translate(key, { version: value.version, backup: value.backup });
    case "gm.configReload":
    case "gm.serverApply":
      return translate(key, { count: value.servers ?? value.hosts, version: value.version });
    case "gm.activityUpload":
    case "gm.serverBuild":
      return translate(key, { file: value.file, version: value.version, revision: value.revision });
    case "gm.activityCurrent":
      return translate(key, { version: value.version, date: value.date ? formatReleaseDate(value.date) : "" });
    case "gm.serverPush":
    case "gm.clientPull":
    case "gm.clientPush":
      return translate(key, { version: value.version });
    case "gm.activityReload":
      return translate(key, { count: value.activities });
    case "gm.clientUpload":
      return translate(key, { file: value.file, size: formatReleaseBytes(value.sizeBytes), version: value.version });
    case "gm.maintenance":
      return translate(key, { window: formatReleaseRange(value.start, value.end) });
    case "gm.shutdown":
      return translate(key, { count: formatReleaseCount(value.players), time: value.at ? formatClockTime(Date.parse(value.at)) : "" });
    case "gm.clientOpen":
      return translate(key, { version: value.version, at: formatReleaseTime(value.at) });
    case "gm.restart":
      return translate(key, { count: value.servers, version: value.version });
    default:
      return translate(key);
  }
}

/** What a finished step did, in one line (summary page and history). */
export function stepResultText(taskId, { status, result = {} } = {}, { cocosVersion = "" } = {}, translate = t) {
  if (status === "skipped") return translate("releaseFlow.summary.skipped");
  const value = result || {};
  switch (taskId) {
    case "db.sync":
      return translate("releaseFlow.summary.db.sync", { tables: formatReleaseCount(value.tables), rows: formatReleaseCount(value.rows) });
    case "db.restore":
      return translate("releaseFlow.backup.restored", { time: formatDateTime(value.backup?.at) });
    case "db.plans":
      return translate("releaseFlow.summary.db.plans", { open: value.open ?? 0, close: value.close ?? 0 });
    case "client.svn":
      return translate("releaseFlow.summary.client.svn", { revision: value.revision, count: value.resolved || 0 });
    case "client.sync":
      return translate("releaseFlow.files.done", { added: value.added, modified: value.modified, deleted: value.deleted });
    case "client.transfer":
      return translate("releaseFlow.transfer.done", { count: value.copiedFiles });
    case "client.diff":
      return translate("releaseFlow.diff.done", { count: value.files });
    case "build.cocos":
      return translate("releaseFlow.summary.build", { version: value.engineVersion || cocosVersion, platform: value.platform || "android" });
    default:
      return gmResultText(taskId, value, translate);
  }
}

/** "10/25 14:02", or "" for no time. */
export function formatDateTime(timestamp, locale = language.locale.value) {
  const value = typeof timestamp === "string" ? Date.parse(timestamp) : Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

/** "10/25 (Sat)" for a timestamp, for day headings. */
export function formatDayOf(timestamp, locale = language.locale.value) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(value));
}

/** What a platform card or the overview says about one issue of an update. */
export function issueText(issue, translate = t) {
  switch (issue?.kind) {
    case "failed":
      return translate("releaseFlow.issue.failed", { step: taskTitle(issue.taskId, translate) });
    case "conflicts":
      return translate("releaseFlow.issue.conflicts", { count: issue.count });
    case "missing":
      return translate("releaseFlow.issue.missing", { count: issue.count });
    case "stale":
      return translate("releaseFlow.issue.stale", { count: issue.count });
    case "overdue":
      return translate("releaseFlow.issue.overdue");
    case "autoPaused":
      return translate("releaseFlow.issue.autoPaused", { reason: autopilotReasonText(issue.reason, issue.taskId, translate) });
    default:
      return "";
  }
}

/** Why one-click mode stopped, in a few words. */
export function autopilotReasonText(reason, taskId = "", translate = t) {
  const key = `releaseFlow.autopilot.reason.${reason || "stopped"}`;
  const text = translate(key, { step: taskId ? taskTitle(taskId, translate) : "" });
  return text === key ? translate("releaseFlow.autopilot.reason.stopped") : text;
}

/** How one-click mode handles problems, one line per rule (its confirmation and panel). */
export function autopilotRuleSummary(rules, translate = t) {
  const lines = AUTOPILOT_RULES.map(({ id, choices }) => translate("releaseFlow.autopilot.summaryLine", {
    rule: translate(`releaseFlow.autopilot.rule.${id}`),
    choice: translate(`releaseFlow.autopilot.choice.${id}.${choices.includes(rules?.[id]) ? rules[id] : choices[0]}`),
  }));
  lines.unshift(rules?.retries
    ? translate("releaseFlow.autopilot.retrySummary", { count: rules.retries, seconds: rules.retryDelay })
    : translate("releaseFlow.autopilot.noRetrySummary"));
  return lines;
}

/** Smooth scrolling unless the person asked for reduced motion. */
export function scrollBehavior() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth";
}

export function taskTitle(taskId, translate = t) {
  return translate(`releaseFlow.task.${taskId}.title`);
}

/** A page's title; the last GM page is named by the update mode. */
export function pageTitle(pageId, mode = "", translate = t) {
  if (pageId === "gmServer") return translate(`releaseFlow.page.gmServer.title.${mode || "maintenance"}`);
  return translate(`releaseFlow.page.${pageId}.title`);
}

export function phaseTitle(phase, translate = t) {
  return translate(`releaseFlow.phase.${phase}`);
}

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

export function formatReleaseCount(value, locale = language.locale.value) {
  return new Intl.NumberFormat(locale).format(Number(value) || 0);
}

function dateFromIso(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

/** "2026/10/24 (Sat)" style, following the interface language. */
function spaceCjkWeekday(text) {
  return String(text || "").replace(/(\d)(周|週)/g, "$1 $2");
}

function formatIsoDate(iso, options, locale) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return "";
  return spaceCjkWeekday(new Intl.DateTimeFormat(locale, options).format(dateFromIso(iso)));
}

export function formatReleaseDate(iso, locale = language.locale.value) {
  return formatIsoDate(iso, { year: "numeric", month: "numeric", day: "numeric", weekday: "short" }, locale);
}

/** The weekday alone, beside a date picker that already shows the date. */
export function formatReleaseWeekday(iso, locale = language.locale.value) {
  return formatIsoDate(iso, { weekday: "short" }, locale);
}

export function formatClockTime(timestamp, locale = language.locale.value) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(new Date(timestamp));
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
      return "";
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
  return spaceCjkWeekday(new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(value)));
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

export function pageTitle(pageId, translate = t) {
  return translate(`releaseFlow.page.${pageId}.title`);
}

export function phaseTitle(phase, translate = t) {
  return translate(`releaseFlow.phase.${phase}`);
}

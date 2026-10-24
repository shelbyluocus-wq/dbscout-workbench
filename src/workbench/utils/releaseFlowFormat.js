// Display helpers shared by the release workspace components.
import { language, t } from "../i18n/index.js";

export function formatReleaseDuration(ms, translate = t) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return translate("releaseFlow.duration.seconds", { seconds });
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
export function formatReleaseDate(iso, locale = language.locale.value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return "";
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", weekday: "short" })
    .format(dateFromIso(iso));
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
  switch (taskId) {
    case "gm.activityUpload":
    case "gm.serverUpload":
      return translate(key, { file: result.file, version: result.version });
    case "gm.activityCurrent":
    case "gm.serverCurrent":
      return translate(key, { version: result.version });
    case "gm.activityReload":
      return translate(key, { count: result.activities });
    case "gm.clientUpload":
      return translate(key, { file: result.file, size: formatReleaseBytes(result.sizeBytes), version: result.version });
    case "gm.maintenance":
      return translate(key, { window: formatReleaseRange(result.start, result.end) });
    case "gm.clientOpen":
      return translate(key, { version: result.version, at: formatReleaseTime(result.at) });
    case "gm.restart":
      return translate(key, { count: result.servers, version: result.version });
    default:
      return translate(key);
  }
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

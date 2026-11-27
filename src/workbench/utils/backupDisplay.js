import { language } from "../i18n/index.js";

// Snapshot timestamps arrive either as ISO strings or in the compact UTC
// `YYYYMMDD-HHmmss` form used by snapshot file names.
export function parseBackupTimestamp(ts) {
  if (!ts) return null;
  const raw = String(ts).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(raw);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : raw.replace(/(\.\d{3})\d+(?=(?:[+-]\d{2}:?\d{2}|Z)?$)/i, "$1");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatBackupTimestamp(ts, locale = language.intlLocale.value) {
  if (!ts) return "";
  const date = parseBackupTimestamp(ts);
  if (!date) return String(ts).trim();
  return date.toLocaleString(locale, { hour12: false });
}

/**
 * Format 243 backup timestamps consistently as local `YYYY-MM-DD HH:mm:ss`,
 * matching the dump-derived `最近变化` style while converting RFC3339 / UTC
 * strings (including nanosecond precision from Rust chrono) cleanly.
 */
export function formatGmBackupLocalTimestamp(ts) {
  const raw = String(ts || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)) {
    return raw;
  }
  const date = parseBackupTimestamp(raw);
  if (!date) return raw;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatBackupSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

import { language } from "../i18n/index.js";

// Snapshot timestamps arrive either as ISO strings or in the compact UTC
// `YYYYMMDD-HHmmss` form used by snapshot file names.
export function parseBackupTimestamp(ts) {
  if (!ts) return null;
  const raw = String(ts).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(raw);
  const date = compact
    ? new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatBackupTimestamp(ts, locale = language.intlLocale.value) {
  if (!ts) return "";
  const date = parseBackupTimestamp(ts);
  if (!date) return String(ts).trim();
  return date.toLocaleString(locale, { hour12: false });
}

export function formatBackupSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
